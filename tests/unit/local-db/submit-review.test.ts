import { beforeEach, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../../lib/local-db/executor";
import { createNodeExecutor } from "../../../lib/local-db/testing/executor";
import { migrateLocalSchema, setMeta } from "../../../lib/local-db/schema";
import { getStats } from "../../../lib/local-db/operations";
import { getPendingOps } from "../../../lib/local-db/sync/oplog";
import { submitReviewLocal } from "../../../lib/local-db/submit-review";

let db: SqlExecutor;

async function seedWord(uuid = "u1") {
  await db.run(
    `INSERT INTO words (uuid, server_id, word, translation, definitions, examples,
       source_language, target_language, created_at, updated_at)
     VALUES (?, 7, 'apple', '蘋果', '[]', '[]', 'en', 'zh-CN',
       '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    [uuid]
  );
}

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
  await seedWord();
});

describe("submitReviewLocal", () => {
  test("SM-2 good on a new word writes review, history and two ops", async () => {
    const result = await submitReviewLocal(db, {
      wordUuid: "u1",
      rating: "good",
      timezone: "UTC",
    });

    expect(result.wordId).toBe(7);
    expect(result.response.interval).toBe(1);

    const reviews = await db.all<Record<string, unknown>>(
      "SELECT * FROM reviews"
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].interval).toBe(1);
    expect(reviews[0].last_reviewed).toBeTruthy();

    const history = await db.all<Record<string, unknown>>(
      "SELECT * FROM review_history"
    );
    expect(history).toHaveLength(1);
    expect(history[0].algorithm).toBe("sm2");

    const ops = await getPendingOps(db);
    expect(ops.map((op) => op.entity).sort()).toEqual(["history", "review"]);
  });

  test("a reviewed word leaves the new queue and enters the due queue", async () => {
    await submitReviewLocal(db, {
      wordUuid: "u1",
      rating: "again",
      timezone: "UTC",
      now: new Date("2026-11-09T10:00:00.000Z"),
    });
    const stats = await getStats(db, new Date("2026-11-10T00:00:00.000Z"));
    expect(stats.newWords).toBe(0);
    expect(stats.due).toBe(1);
  });

  test("FSRS mode writes fsrs columns", async () => {
    await setMeta(db, "srs_algorithm", "fsrs");
    await submitReviewLocal(db, { wordUuid: "u1", rating: "easy", timezone: "UTC" });
    const reviews = await db.all<Record<string, unknown>>(
      "SELECT * FROM reviews"
    );
    expect(reviews[0].stability).toBeGreaterThan(0);
    expect(reviews[0].fsrs_state).not.toBeNull();
  });

  test("rejects tombstones", async () => {
    await db.run(
      "UPDATE words SET deleted_at = '2026-11-05T00:00:00.000Z' WHERE uuid = 'u1'"
    );
    await expect(
      submitReviewLocal(db, { wordUuid: "u1", rating: "good", timezone: "UTC" })
    ).rejects.toThrow("Word not found");
  });
});
