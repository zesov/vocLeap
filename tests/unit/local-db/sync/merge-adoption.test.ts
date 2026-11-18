import { beforeEach, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../../../lib/local-db/executor";
import { createNodeExecutor } from "../../../../lib/local-db/testing/executor";
import { migrateLocalSchema } from "../../../../lib/local-db/schema";
import { saveWordLocal } from "../../../../lib/local-db/operations";
import { enqueueOp, getPendingOps } from "../../../../lib/local-db/sync/oplog";
import { mergePullPage } from "../../../../lib/local-db/sync/merge";
import { ZERO_CURSOR } from "../../../../lib/sync/cursor";
import type { PullPage } from "../../../../lib/sync/server-pull";
import type { WordPayload } from "../../../../lib/sync/types";

let db: SqlExecutor;

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
});

function serverWord(uuid: string, word: string, updatedAt: string, serverId = 42): WordPayload {
  return {
    uuid,
    serverId,
    word,
    translation: "server translation",
    definitions: ["server def"],
    examples: [],
    phonetic: "/server/",
    audioUrl: null,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    createdAt: updatedAt,
    updatedAt,
    deletedAt: null,
  };
}

function pageWith(words: WordPayload[]): PullPage {
  return {
    words,
    reviews: [],
    history: [],
    settings: { srsAlgorithm: "sm2" },
    nextCursor: ZERO_CURSOR,
  };
}

describe("duplicate adoption in mergePullPage", () => {
  test("folds a locally-created duplicate into the server row and remaps reviews", async () => {
    // The device created "apple" offline under uuid B, reviewed it once
    // (review + pending review op still queued), then the server's own
    // "apple" (uuid A) arrives from a pull.
    const local = await saveWordLocal(db, { word: "apple", translation: "本地譯" });
    await db.batch([
      {
        sql: `INSERT INTO reviews (
                word_uuid, ease_factor, interval, repetitions, next_review_date,
                last_reviewed, updated_at
              ) VALUES (?, 2.5, 1, 1, '2026-11-20T00:00:00.000Z', '2026-11-16T00:00:00.000Z',
                '2026-11-16T00:00:00.000Z')`,
        params: [local.uuid],
      },
    ]);
    await enqueueOp(db, "review", "upsert", {
      wordUuid: local.uuid,
      easeFactor: 2.5,
      interval: 1,
      repetitions: 1,
      nextReviewDate: "2026-11-20T00:00:00.000Z",
      lastReviewed: "2026-11-16T00:00:00.000Z",
      stability: null,
      difficulty: null,
      fsrsState: null,
      lapses: 0,
      fsrsReps: 1,
      fsrsLastReview: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    });
    await db.batch([
      {
        sql: `INSERT INTO review_history (
                uuid, word_uuid, rating, previous_ease_factor,
                previous_interval, previous_repetitions, new_ease_factor,
                new_interval, new_repetitions, algorithm, snapshot, reviewed_at
              ) VALUES ('h1', ?, 4, 2.5, 0, 0, 2.6, 1, 1, 'sm2', NULL,
                '2026-11-16T00:00:00.000Z')`,
        params: [local.uuid],
      },
    ]);
    await enqueueOp(db, "history", "upsert", {
      uuid: "h1",
      wordUuid: local.uuid,
      rating: 4,
      previousEaseFactor: 2.5,
      previousInterval: 0,
      previousRepetitions: 0,
      newEaseFactor: 2.6,
      newInterval: 1,
      newRepetitions: 1,
      algorithm: "sm2",
      snapshot: null,
      reviewedAt: "2026-11-16T00:00:00.000Z",
    });
    // Simulate the real cycle order: the word op was pushed (the server
    // folded it into the surviving row) and acked, while the review and
    // history ops are still queued.
    await db.run("DELETE FROM sync_ops WHERE entity = 'word'");

    const stats = await mergePullPage(
      db,
      pageWith([serverWord("uuid-A", "apple", "2026-11-17T00:00:00.000Z")])
    );

    // Only the server row survives, carrying its server id.
    const words = await db.all<{ uuid: string; server_id: number | null }>(
      "SELECT uuid, server_id FROM words"
    );
    expect(words).toHaveLength(1);
    expect(words[0].uuid).toBe("uuid-A");
    expect(words[0].server_id).toBe(42);
    expect(String(words[0].server_id)).toBe("42");
    expect(stats.words).toBe(1);

    // The offline review and history were remapped to the surviving uuid.
    const reviews = await db.all<{ word_uuid: string }>("SELECT word_uuid FROM reviews");
    expect(reviews).toHaveLength(1);
    expect(reviews[0].word_uuid).toBe("uuid-A");

    const history = await db.all<{ word_uuid: string }>(
      "SELECT word_uuid FROM review_history WHERE uuid = 'h1'"
    );
    expect(history[0].word_uuid).toBe("uuid-A");

    // Queued review/history ops now reference the surviving uuid, so the
    // next push applies instead of being rejected as an unknown word.
    const ops = await getPendingOps(db);
    const reviewOp = ops.find((op) => op.entity === "review");
    expect((reviewOp?.payload as { wordUuid: string }).wordUuid).toBe("uuid-A");
    const historyOp = ops.find((op) => op.entity === "history");
    expect((historyOp?.payload as { wordUuid: string }).wordUuid).toBe("uuid-A");
  });

  test("defers the incoming word while the duplicate still has pending word ops", async () => {
    // uuid B was created offline and its word op is still queued. Adopting
    // now would orphan queued review ops pointing at B; inserting the server
    // row now would violate the local unique word-text index. The word is
    // skipped this cycle and re-delivered for adoption after the op pushes.
    await saveWordLocal(db, { word: "apple", translation: "本地譯" });

    const stats = await mergePullPage(
      db,
      pageWith([serverWord("uuid-A", "apple", "2026-11-17T00:00:00.000Z")])
    );

    const words = await db.all<{ uuid: string }>("SELECT uuid FROM words");
    expect(words).toHaveLength(1);
    expect(words[0].uuid).not.toBe("uuid-A");
    expect(stats.words).toBe(0);

    // The queued word op was left untouched.
    const ops = await getPendingOps(db);
    expect(ops).toHaveLength(1);
    expect(ops[0].entity).toBe("word");
  });

  test("an older server review does not clobber the remapped local review", async () => {
    // Local duplicate with a NEWER review (offline rating), server row with
    // an OLDER review: after adoption the local review must win.
    const local = await saveWordLocal(db, { word: "apple", translation: "本地譯" });
    // The word op is already pushed and acked in this scenario.
    await db.run("DELETE FROM sync_ops WHERE entity = 'word'");
    await db.batch([
      {
        sql: `INSERT INTO reviews (
                word_uuid, ease_factor, interval, repetitions, next_review_date,
                last_reviewed, updated_at
              ) VALUES (?, 3.0, 5, 3, '2026-11-25T00:00:00.000Z', '2026-11-18T00:00:00.000Z',
                '2026-11-18T00:00:00.000Z')`,
        params: [local.uuid],
      },
    ]);

    const stats = await mergePullPage(db, {
      words: [serverWord("uuid-A", "apple", "2026-11-17T00:00:00.000Z")],
      reviews: [
        {
          wordUuid: "uuid-A",
          easeFactor: 2.5,
          interval: 1,
          repetitions: 1,
          nextReviewDate: "2026-11-19T00:00:00.000Z",
          lastReviewed: "2026-11-14T00:00:00.000Z",
          stability: null,
          difficulty: null,
          fsrsState: null,
          lapses: 0,
          fsrsReps: 1,
          fsrsLastReview: "2026-11-14T00:00:00.000Z",
          updatedAt: "2026-11-14T00:00:00.000Z",
        },
      ],
      history: [],
      settings: { srsAlgorithm: "sm2" },
      nextCursor: ZERO_CURSOR,
    });
    void stats;

    const reviews = await db.all<{
      word_uuid: string;
      ease_factor: number;
      interval: number;
      last_reviewed: string;
    }>("SELECT word_uuid, ease_factor, interval, last_reviewed FROM reviews");
    expect(reviews).toHaveLength(1);
    expect(reviews[0].word_uuid).toBe("uuid-A");
    // The newer local review survived; the older server review was skipped.
    expect(reviews[0].ease_factor).toBe(3.0);
    expect(reviews[0].interval).toBe(5);
    expect(reviews[0].last_reviewed).toBe("2026-11-18T00:00:00.000Z");
  });
});
