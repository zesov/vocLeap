import { beforeEach, describe, expect, test } from "bun:test";
import { ensureSchema } from "../db/schema";
import { createTestAdapter, type TestAdapter } from "../db/testing";
import { ZERO_CURSOR } from "./cursor";
import { pullPage } from "./server-pull";

let db: TestAdapter;

beforeEach(async () => {
  db = createTestAdapter();
  await ensureSchema(db);
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (1, 'a@b.c', 'x')")
    .run();
});

async function insertWord(
  uuid: string,
  word: string,
  updatedAt: string
): Promise<number> {
  const result = await db
    .prepare(`
      INSERT INTO words (user_id, uuid, word, translation, updated_at)
      VALUES (1, ?, ?, 'x', ?)
    `)
    .run(uuid, word, updatedAt);
  return Number(result.lastInsertRowid);
}

describe("pullPage", () => {
  test("a zero cursor bootstraps every row, tombstones included", async () => {
    await insertWord("u1", "apple", "2026-11-10 10:00:00");
    const id = await insertWord("u2", "pear", "2026-11-10 11:00:00");
    await db
      .prepare("UPDATE words SET deleted_at = '2026-11-10 12:00:00' WHERE id = ?")
      .run(id);

    const page = await pullPage(db, 1, ZERO_CURSOR);
    expect(page.words.map((w) => w.uuid)).toEqual(["u1", "u2"]);
    expect(page.words[1].deletedAt).toBe("2026-11-10 12:00:00");
    expect(page.nextCursor.wId).toBe(id);
  });

  test("the cursor excludes rows already returned", async () => {
    await insertWord("u1", "apple", "2026-11-10 10:00:00");
    await insertWord("u2", "pear", "2026-11-10 11:00:00");

    const first = await pullPage(db, 1, ZERO_CURSOR);
    const second = await pullPage(db, 1, first.nextCursor);
    expect(second.words).toEqual([]);
  });

  test("equal timestamps fall back to the id tie-breaker", async () => {
    const first = await insertWord("u1", "apple", "2026-11-10 10:00:00");
    await insertWord("u2", "pear", "2026-11-10 10:00:00");

    const page = await pullPage(db, 1, {
      ...ZERO_CURSOR,
      wTs: "2026-11-10 10:00:00",
      wId: first,
    });
    expect(page.words.map((w) => w.uuid)).toEqual(["u2"]);
  });

  test("respects the limit and advances only to the last returned row", async () => {
    await insertWord("u1", "apple", "2026-11-10 10:00:00");
    await insertWord("u2", "pear", "2026-11-10 11:00:00");
    await insertWord("u3", "plum", "2026-11-10 12:00:00");

    const page = await pullPage(db, 1, ZERO_CURSOR, 2);
    expect(page.words).toHaveLength(2);
    expect(page.nextCursor.wId).toBe(2);
  });

  test("reviews and history page by their own high-water marks", async () => {
    const wordId = await insertWord("u1", "apple", "2026-11-10 10:00:00");
    await db
      .prepare(`
        INSERT INTO reviews (word_id, ease_factor, interval, repetitions,
          next_review_date, last_reviewed, updated_at)
        VALUES (?, 2.5, 1, 1, '2026-11-11 00:00:00', '2026-11-10 10:00:00', '2026-11-10 10:00:00')
      `)
      .run(wordId);
    await db
      .prepare(`
        INSERT INTO review_history (uuid, word_id, rating,
          previous_ease_factor, previous_interval, previous_repetitions,
          new_ease_factor, new_interval, new_repetitions, reviewed_at)
        VALUES ('h1', ?, 3, 2.5, 0, 0, 2.5, 1, 1, '2026-11-10 10:00:00')
      `)
      .run(wordId);

    const page = await pullPage(db, 1, ZERO_CURSOR);
    expect(page.words).toHaveLength(1);
    expect(page.reviews).toHaveLength(1);
    expect(page.reviews[0].wordUuid).toBe("u1");
    expect(page.history).toHaveLength(1);
    expect(page.history[0].uuid).toBe("h1");
    expect(page.settings.srsAlgorithm).toBe("sm2");
  });

  test("history ignores rows from another user", async () => {
    await db
      .prepare("INSERT INTO users (id, email, password_hash) VALUES (2, 'b@b.c', 'x')")
      .run();
    const foreignWord = await db
      .prepare("INSERT INTO words (user_id, uuid, word, translation) VALUES (2, 'u9', 'other', 'x')")
      .run();
    await db
      .prepare(`
        INSERT INTO review_history (uuid, word_id, rating,
          previous_ease_factor, previous_interval, previous_repetitions,
          new_ease_factor, new_interval, new_repetitions)
        VALUES ('h9', ?, 3, 2.5, 0, 0, 2.5, 1, 1)
      `)
      .run(Number(foreignWord.lastInsertRowid));

    const page = await pullPage(db, 1, ZERO_CURSOR);
    expect(page.history).toEqual([]);
  });
});
