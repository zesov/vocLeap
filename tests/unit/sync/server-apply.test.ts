import { beforeEach, describe, expect, test } from "bun:test";
import { ensureSchema } from "../../../lib/db/schema.ts";
import { createTestAdapter, type TestAdapter } from "../../../lib/db/testing.ts";
import { applyOps } from "../../../lib/sync/server-apply.ts";
import type { SyncOp } from "./types";

let db: TestAdapter;

beforeEach(async () => {
  db = createTestAdapter();
  await ensureSchema(db);
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (1, 'a@b.c', 'x')")
    .run();
});

function wordOp(overrides: Record<string, unknown> = {}): SyncOp {
  return {
    opId: crypto.randomUUID(),
    entity: "word",
    op: "upsert",
    payload: {
      uuid: "0190b7a0-0000-7000-8000-000000000001",
      word: "apple",
      translation: "蘋果",
      definitions: ["a fruit"],
      examples: [],
      phonetic: "/ˈæp.əl/",
      audioUrl: null,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      createdAt: "2026-11-10T10:00:00.000Z",
      updatedAt: "2026-11-10T10:00:00.000Z",
      deletedAt: null,
      ...overrides,
    },
  };
}

async function wordRow(uuid: string) {
  return (await db
    .prepare("SELECT * FROM words WHERE uuid = ?")
    .get(uuid)) as Record<string, unknown> | null;
}

describe("applyOps word upserts", () => {
  test("inserts a new word with its uuid", async () => {
    const op = wordOp();
    const [result] = await applyOps(db, 1, [op]);
    expect(result).toEqual({ opId: op.opId, accepted: true });
    const row = await wordRow(String(op.payload.uuid));
    expect(row?.translation).toBe("蘋果");
    expect(row?.user_id).toBe(1);
    expect(row?.deleted_at).toBeNull();
  });

  test("last write wins by updated_at", async () => {
    await applyOps(db, 1, [wordOp()]);
    await applyOps(db, 1, [
      wordOp({
        translation: "stale",
        updatedAt: "2026-11-10T09:00:00.000Z",
      }),
    ]);
    expect((await wordRow(String(wordOp().payload.uuid)))?.translation).toBe(
      "蘋果"
    );

    await applyOps(db, 1, [
      wordOp({
        translation: "新鮮",
        updatedAt: "2026-11-11T09:00:00.000Z",
      }),
    ]);
    expect((await wordRow(String(wordOp().payload.uuid)))?.translation).toBe(
      "新鮮"
    );
  });

  test("a delete op writes a tombstone", async () => {
    const op = wordOp();
    await applyOps(db, 1, [op]);
    const [result] = await applyOps(db, 1, [
      {
        opId: crypto.randomUUID(),
        entity: "word",
        op: "delete",
        payload: {
          uuid: op.payload.uuid,
          deletedAt: "2026-11-12T00:00:00.000Z",
        },
      },
    ]);
    expect(result.accepted).toBe(true);
    expect((await wordRow(String(op.payload.uuid)))?.deleted_at).toBe(
      "2026-11-12T00:00:00.000Z"
    );
  });

  test("re-adding an existing term merges into the existing identity", async () => {
    await applyOps(db, 1, [wordOp()]);
    const [result] = await applyOps(db, 1, [
      wordOp({
        uuid: "0190b7a0-0000-7000-8000-000000000002",
        translation: "苹果",
        updatedAt: "2026-11-11T00:00:00.000Z",
      }),
    ]);
    expect(result).toEqual({
      opId: expect.any(String),
      accepted: true,
      reason: "merged",
    });
    const rows = (await db
      .prepare("SELECT uuid, translation FROM words WHERE user_id = 1")
      .all()) as Array<{ uuid: string; translation: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].translation).toBe("苹果");
  });

  test("does not touch another user's row with a colliding uuid", async () => {
    await db
      .prepare("INSERT INTO users (id, email, password_hash) VALUES (2, 'b@b.c', 'x')")
      .run();
    const foreign = wordOp();
    await applyOps(db, 2, [foreign]);
    await applyOps(db, 1, [wordOp({ translation: "hijack" })]);
    const row = await wordRow(String(foreign.payload.uuid));
    expect(row?.user_id).toBe(2);
    expect(row?.translation).toBe("蘋果");
  });
});

describe("applyOps reviews, history and settings", () => {
  test("review upserts resolve the word uuid and use last_reviewed as the clock", async () => {
    const word = wordOp();
    await applyOps(db, 1, [word]);
    const review = (lastReviewed: string, interval: number): SyncOp => ({
      opId: crypto.randomUUID(),
      entity: "review",
      op: "upsert",
      payload: {
        wordUuid: word.payload.uuid,
        easeFactor: 2.5,
        interval,
        repetitions: interval,
        nextReviewDate: "2026-11-20 00:00:00",
        lastReviewed,
        stability: null,
        difficulty: null,
        fsrsState: null,
        lapses: null,
        fsrsReps: null,
        fsrsLastReview: null,
        updatedAt: lastReviewed,
      },
    });

    await applyOps(db, 1, [review("2026-11-10T10:00:00.000Z", 1)]);
    await applyOps(db, 1, [review("2026-11-09T10:00:00.000Z", 9)]);
    let row = (await db.prepare("SELECT * FROM reviews").get()) as Record<string, unknown>;
    expect(row.interval).toBe(1);

    await applyOps(db, 1, [review("2026-11-11T10:00:00.000Z", 6)]);
    row = (await db.prepare("SELECT * FROM reviews").get()) as Record<string, unknown>;
    expect(row.interval).toBe(6);
  });

  test("history inserts are append-only by uuid", async () => {
    const word = wordOp();
    await applyOps(db, 1, [word]);
    const history: SyncOp = {
      opId: crypto.randomUUID(),
      entity: "history",
      op: "upsert",
      payload: {
        uuid: "0190b7a0-0000-7000-8000-0000000000aa",
        wordUuid: word.payload.uuid,
        rating: 3,
        previousEaseFactor: 2.5,
        previousInterval: 0,
        previousRepetitions: 0,
        newEaseFactor: 2.5,
        newInterval: 1,
        newRepetitions: 1,
        algorithm: "sm2",
        snapshot: null,
        reviewedAt: "2026-11-10T10:00:00.000Z",
      },
    };
    await applyOps(db, 1, [history, history]);
    const rows = (await db.prepare("SELECT id FROM review_history").all()) as unknown[];
    expect(rows).toHaveLength(1);
  });

  test("settings overwrite the user's algorithm", async () => {
    const [result] = await applyOps(db, 1, [
      {
        opId: crypto.randomUUID(),
        entity: "settings",
        op: "upsert",
        payload: { srsAlgorithm: "fsrs" },
      },
    ]);
    expect(result.accepted).toBe(true);
    const row = (await db
      .prepare("SELECT srs_algorithm FROM users WHERE id = 1")
      .get()) as Record<string, unknown>;
    expect(row.srs_algorithm).toBe("fsrs");
  });
});
