import { beforeEach, describe, expect, test } from "bun:test";
import type { DictionaryResult } from "../../../lib/data/types";
import type { SqlExecutor } from "../../../lib/local-db/executor";
import { backfillBareWords } from "../../../lib/local-db/backfill";
import { createNodeExecutor } from "../../../lib/local-db/testing/executor";
import { getMeta, migrateLocalSchema } from "../../../lib/local-db/schema";
import { saveWordLocal } from "../../../lib/local-db/operations";
import { getPendingOps } from "../../../lib/local-db/sync/oplog";

let db: SqlExecutor;

function translateResult(word: string): DictionaryResult {
  return {
    word,
    translation: `译文:${word}`,
    definitions: [
      { partOfSpeech: "noun", definition: `def of ${word}`, examples: [`an example of ${word}`] },
    ],
    phonetic: `/ˈ${word}/`,
    audioUrl: `https://audio.test/${word}.mp3`,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
  };
}

function failingTranslate(error: Error) {
  return async () => {
    throw error;
  };
}

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
});

describe("backfillBareWords", () => {
  test("fills the oldest bare words, updates rows and enqueues word ops", async () => {
    await saveWordLocal(db, { word: "zebra", translation: "" });
    await saveWordLocal(db, { word: "apple", translation: "" });
    await saveWordLocal(db, { word: "full", translation: "already translated" });

    const seen: string[] = [];
    const filled = await backfillBareWords(db, {
      async translate(input) {
        seen.push(input.word);
        return translateResult(input.word);
      },
    });

    expect(filled).toBe(2);
    expect(seen).toEqual(["zebra", "apple"]);

    const rows = await db.all<{ word: string; translation: string; phonetic: string }>(
      "SELECT word, translation, phonetic FROM words ORDER BY word"
    );
    const zebra = rows.find((r) => r.word === "zebra");
    expect(zebra?.translation).toBe("译文:zebra");
    expect(zebra?.phonetic).toBe("/ˈzebra/");

    // Row updates each carry a word op so the server learns the enrichment.
    const ops = await getPendingOps(db);
    const wordOps = ops.filter((op) => op.entity === "word");
    // 3 saves + 2 backfill updates
    expect(wordOps).toHaveLength(5);
  });

  test("counts failures and gives up on a word after five attempts", async () => {
    const saved = await saveWordLocal(db, { word: "cursed", translation: "" });
    const failing = failingTranslate(new Error("upstream 500"));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await backfillBareWords(db, { translate: failing });
    }
    const counts = JSON.parse((await getMeta(db, "backfill_failures")) ?? "{}");
    expect(counts[saved.uuid]).toBe(5);

    // Sixth cycle: the word is skipped, translate is not called again.
    let called = 0;
    await backfillBareWords(db, {
      async translate(input) {
        called += 1;
        return translateResult(input.word);
      },
    });
    expect(called).toBe(0);
    expect(
      await db.all<{ translation: string }>("SELECT translation FROM words")
    ).toHaveLength(1);
  });
});
