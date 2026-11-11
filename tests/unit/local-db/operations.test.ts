import { beforeEach, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../../lib/local-db/executor";
import { createNodeExecutor } from "../../../lib/local-db/testing/executor";
import { getMeta, migrateLocalSchema } from "../../../lib/local-db/schema";
import {
  deleteWordLocal,
  getDueReviews,
  getHistoryPage,
  getNewWords,
  getStats,
  getWordByText,
  getWordsPage,
  setAlgorithmLocal,
  updateWordLocal,
} from "../../../lib/local-db/operations";
import { getPendingOps } from "../../../lib/local-db/sync/oplog.ts";

let db: SqlExecutor;
const NOW = new Date("2026-11-10T12:00:00.000Z");

async function seedWord(
  uuid: string,
  word: string,
  updatedAt: string,
  deletedAt: string | null = null
) {
  await db.run(
    `INSERT INTO words (uuid, server_id, word, translation, definitions, examples,
       source_language, target_language, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, 'translation', '[]', '[]', 'en', 'zh-CN', ?, ?, ?)`,
    [uuid, uuid === "u1" ? 1 : uuid === "u2" ? 2 : 3, word, updatedAt, updatedAt, deletedAt]
  );
}

async function seedReview(uuid: string, nextReviewDate: string) {
  await db.run(
    `INSERT INTO reviews (word_uuid, ease_factor, interval, repetitions, next_review_date, last_reviewed, updated_at)
     VALUES (?, 2.5, 1, 1, ?, '2026-11-09 10:00:00', '2026-11-09 10:00:00')`,
    [uuid, nextReviewDate]
  );
}

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
});

describe("local reads", () => {
  test("due queue only returns live words whose date has passed", async () => {
    await seedWord("u1", "apple", "2026-11-01T00:00:00.000Z");
    await seedWord("u2", "pear", "2026-11-02T00:00:00.000Z");
    await seedWord("u3", "gone", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z");
    await seedReview("u1", "2026-11-10 00:00:00");
    await seedReview("u2", "2026-12-01 00:00:00");
    await seedReview("u3", "2026-11-01 00:00:00");

    const due = await getDueReviews(db, 10, NOW);
    expect(due.map((r) => r.word.word)).toEqual(["apple"]);
    expect(due[0].wordId).toBe(1);
  });

  test("new queue returns never-reviewed live words", async () => {
    await seedWord("u1", "apple", "2026-11-01T00:00:00.000Z");
    await seedWord("u2", "pear", "2026-11-02T00:00:00.000Z");
    await seedReview("u1", "2026-11-10 00:00:00");

    const fresh = await getNewWords(db, 10);
    expect(fresh.map((r) => r.word.word)).toEqual(["pear"]);
  });

  test("stats exclude tombstones", async () => {
    await seedWord("u1", "apple", "2026-11-01T00:00:00.000Z");
    await seedWord("u2", "pear", "2026-11-02T00:00:00.000Z");
    await seedWord("u3", "gone", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z");
    await seedReview("u1", "2026-11-10 00:00:00");

    expect(await getStats(db, NOW)).toEqual({ due: 1, total: 2, newWords: 1 });
  });

  test("words page sorts and paginates", async () => {
    await seedWord("u1", "banana", "2026-11-01T00:00:00.000Z");
    await seedWord("u2", "apple", "2026-11-02T00:00:00.000Z");

    const alpha = await getWordsPage(db, 1, 0, "alpha_asc");
    expect(alpha.words.map((w) => w.word)).toEqual(["apple"]);
    expect(alpha.total).toBe(2);
    expect(alpha.hasMore).toBe(true);

    const next = await getWordsPage(db, 1, 1, "alpha_asc");
    expect(next.words.map((w) => w.word)).toEqual(["banana"]);
    expect(next.hasMore).toBe(false);
  });

  test("history page joins word text and hides tombstones", async () => {
    await seedWord("u1", "apple", "2026-11-01T00:00:00.000Z");
    await seedWord("u2", "gone", "2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z");
    await db.run(
      `INSERT INTO review_history (uuid, word_uuid, rating, previous_ease_factor,
         previous_interval, previous_repetitions, new_ease_factor, new_interval,
         new_repetitions, algorithm, reviewed_at)
       VALUES ('h1', 'u1', 3, 2.5, 0, 0, 2.5, 1, 1, 'sm2', '2026-11-10 10:00:00'),
              ('h2', 'u2', 3, 2.5, 0, 0, 2.5, 1, 1, 'sm2', '2026-11-10 11:00:00')`
    );

    const page = await getHistoryPage(db, 10, 0);
    expect(page.total).toBe(1);
    expect(page.history[0]).toMatchObject({ uuid: "h1", word: "apple" });
  });

  test("getWordByText finds live rows only", async () => {
    await seedWord("u1", "apple", "2026-11-01T00:00:00.000Z");
    await seedWord("u2", "pear", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
    expect((await getWordByText(db, "apple"))?.uuid).toBe("u1");
    expect(await getWordByText(db, "pear")).toBeNull();
  });
});

describe("local writes", () => {
  test("updateWordLocal bumps updated_at and queues an upsert", async () => {
    await seedWord("u1", "apple", "2026-11-01T00:00:00.000Z");
    expect(await updateWordLocal(db, "u1", { translation: "蘋果" })).toBe(true);

    const row = await db.all<{ translation: string; updated_at: string }>(
      "SELECT translation, updated_at FROM words WHERE uuid = 'u1'"
    );
    expect(row[0].translation).toBe("蘋果");
    expect(row[0].updated_at > "2026-11-01T00:00:00.000Z").toBe(true);

    const ops = await getPendingOps(db);
    expect(ops).toHaveLength(1);
    expect(ops[0].entity).toBe("word");
    expect(ops[0].payload.translation).toBe("蘋果");
  });

  test("deleteWordLocal tombstones and queues a delete", async () => {
    await seedWord("u1", "apple", "2026-11-01T00:00:00.000Z");
    expect(await deleteWordLocal(db, "u1")).toBe(true);
    expect(await getWordByText(db, "apple")).toBeNull();

    const ops = await getPendingOps(db);
    expect(ops[0].op).toBe("delete");
    expect(ops[0].payload.uuid).toBe("u1");
  });

  test("setAlgorithmLocal stores meta and queues settings", async () => {
    await setAlgorithmLocal(db, "fsrs");
    expect(await getMeta(db, "srs_algorithm")).toBe("fsrs");
    const ops = await getPendingOps(db);
    expect(ops[0].entity).toBe("settings");
    expect(ops[0].payload).toEqual({ srsAlgorithm: "fsrs" });
  });
});
