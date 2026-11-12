import { beforeEach, describe, expect, test } from "bun:test";
import { decodeCursor, encodeCursor, ZERO_CURSOR } from "../../../../lib/sync/cursor";
import type { PullPage } from "../../../../lib/sync/server-pull";
import type { SqlExecutor } from "../../../../lib/local-db/executor.ts";
import { createNodeExecutor } from "../../../../lib/local-db/testing/executor.ts";
import { getMeta, migrateLocalSchema } from "../../../../lib/local-db/schema.ts";
import { enqueueOp, getPendingOps } from "../../../../lib/local-db/sync/oplog.ts";
import {
  AuthRequiredError,
  discardRejectedOp,
  getSyncStatus,
  isSyncPaused,
  resetSyncPause,
  runSyncOnce,
} from "../../../../lib/local-db/sync/engine.ts";

let db: SqlExecutor;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyPage(): PullPage {
  return {
    words: [],
    reviews: [],
    history: [],
    settings: { srsAlgorithm: "sm2" },
    nextCursor: ZERO_CURSOR,
  };
}

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
  resetSyncPause();
});

describe("runSyncOnce", () => {
  test("pushes ops, acks accepted ones and pulls a page", async () => {
    await enqueueOp(db, "word", "upsert", {
      uuid: "u1",
      word: "apple",
      translation: "t",
      definitions: [],
      examples: [],
      phonetic: null,
      audioUrl: null,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      deletedAt: null,
    });

    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/sync/push") {
        const body = JSON.parse(String(init?.body)) as { ops: Array<{ opId: string }> };
        return json({
          results: body.ops.map((op) => ({ opId: op.opId, accepted: true })),
        });
      }
      return json(emptyPage());
    }) as typeof fetch;

    const status = await runSyncOnce(db, { fetchImpl, now: () => new Date("2026-11-11T00:00:00.000Z") });

    expect(status.phase).toBe("idle");
    expect(calls).toEqual([
      "POST /api/sync/push",
      `GET /api/sync/pull?cursor=${encodeURIComponent(encodeCursor(ZERO_CURSOR))}`,
    ]);
    expect(await getPendingOps(db)).toHaveLength(0);
    expect(await getMeta(db, "last_synced_at")).toBe("2026-11-11T00:00:00.000Z");
  });

  test("rejected ops stay queued and pause the engine", async () => {
    const opId = await enqueueOp(db, "word", "delete", { uuid: "u1", deletedAt: "2026-11-01T00:00:00.000Z" });

    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/sync/push") {
        const body = JSON.parse(String(init?.body)) as { ops: Array<{ opId: string }> };
        return json({
          results: body.ops.map((op) => ({ opId: op.opId, accepted: false, reason: "unknown-word" })),
        });
      }
      return json(emptyPage());
    }) as unknown as typeof fetch;

    await runSyncOnce(db, { fetchImpl });
    expect(isSyncPaused()).toBe(true);
    expect((await getPendingOps(db)).length).toBe(1);
    // The cycle stops on rejection: no pull, and the paused phase survives.
    expect(calls).toEqual(["/api/sync/push"]);

    const status = getSyncStatus();
    expect(status.phase).toBe("paused");
    expect(status.error).toContain("unknown-word");
    expect(status.rejectedOpId).toBe(opId);
  });

  test("discardRejectedOp removes the poison op and unpauses", async () => {
    await enqueueOp(db, "word", "delete", { uuid: "u1", deletedAt: "2026-11-01T00:00:00.000Z" });

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/sync/push") {
        const body = JSON.parse(String(init?.body)) as { ops: Array<{ opId: string }> };
        return json({
          results: body.ops.map((op) => ({ opId: op.opId, accepted: false, reason: "unknown-word" })),
        });
      }
      return json(emptyPage());
    }) as unknown as typeof fetch;

    await runSyncOnce(db, { fetchImpl });
    expect(isSyncPaused()).toBe(true);

    expect(await discardRejectedOp(db)).toBe(true);
    expect(await getPendingOps(db)).toHaveLength(0);
    expect(isSyncPaused()).toBe(false);
    expect(getSyncStatus().phase).toBe("idle");
    expect(getSyncStatus().rejectedOpId).toBeNull();
    expect(getSyncStatus().pending).toBe(0);

    // Nothing recorded: a second call is a harmless no-op.
    expect(await discardRejectedOp(db)).toBe(false);
  });

  test("401 raises AuthRequiredError", async () => {
    await enqueueOp(db, "settings", "upsert", { srsAlgorithm: "fsrs" });
    const fetchImpl = (async () => json({ error: "nope" }, 401)) as unknown as typeof fetch;

    await expect(runSyncOnce(db, { fetchImpl })).rejects.toBeInstanceOf(
      AuthRequiredError
    );
  });

  test("pulls repeatedly until the cursor stops moving", async () => {
    const page1: PullPage = {
      ...emptyPage(),
      words: [
        {
          uuid: "u1",
          word: "apple",
          translation: "t",
          definitions: [],
          examples: [],
          phonetic: null,
          audioUrl: null,
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          deletedAt: null,
        },
      ],
      nextCursor: { wTs: "2026-11-01T00:00:00.000Z", wId: 1, rTs: ZERO_CURSOR.rTs, rId: 0, hId: 0 },
    };
    let pulls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sync/pull")) {
        pulls += 1;
        if (pulls === 1) return json(page1);
        // The real server echoes the cursor when a page has no new rows.
        const cursor = decodeCursor(
          new URL(url, "http://localhost").searchParams.get("cursor")
        );
        return json({ ...emptyPage(), nextCursor: cursor });
      }
      return json({ results: [] });
    }) as unknown as typeof fetch;

    await runSyncOnce(db, { fetchImpl });
    expect(pulls).toBe(2);
    const words = await db.all("SELECT uuid FROM words");
    expect(words).toHaveLength(1);
    expect(await getMeta(db, "sync_cursor")).toBeTruthy();
  });
});
