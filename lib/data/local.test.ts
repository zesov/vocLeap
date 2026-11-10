import { beforeEach, describe, expect, test } from "bun:test";
import { createNodeExecutor } from "../local-db/testing/executor";
import { migrateLocalSchema } from "../local-db/schema";
import { getPendingOps } from "../local-db/sync/oplog";
import type { SqlExecutor } from "../local-db/executor";
import { createLocalData } from "./local";
import type { DataApi } from "./api";

let db: SqlExecutor;
const remoteCalls: string[] = [];
const remote = {
  saveWord: async () => {
    remoteCalls.push("saveWord");
    return { id: 42 } as never;
  },
  translate: async () => {
    remoteCalls.push("translate");
    return {
      word: "apple",
      translation: "蘋果",
      definitions: [],
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    };
  },
} as unknown as DataApi;

async function seed() {
  await db.run(
    `INSERT INTO words (uuid, server_id, word, translation, definitions, examples,
       source_language, target_language, created_at, updated_at)
     VALUES ('u1', 11, 'apple', '蘋果', '[]', '[]', 'en', 'zh-CN',
       '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
  );
}

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
  remoteCalls.length = 0;
  await seed();
});

describe("local data", () => {
  test("reads a page with numeric ids from server_id", async () => {
    const data = createLocalData(db, remote, () => {});
    const page = await data.getWords({ limit: 10, offset: 0, sort: "alpha_asc" });
    expect(page.words[0]).toMatchObject({ id: 11, uuid: "u1", word: "apple" });
  });

  test("new words expose a uuid for review submission", async () => {
    const data = createLocalData(db, remote, () => {});
    const fresh = await data.getNewWords(10);
    expect(fresh[0].uuid).toBe("u1");
    expect(fresh[0].wordId).toBe(11);
  });

  test("submitReview writes locally and triggers sync", async () => {
    let syncs = 0;
    const data = createLocalData(db, remote, () => {
      syncs += 1;
    });

    const result = await data.submitReview({ wordId: 11, rating: "good" });
    expect(result.wordId).toBe(11);
    expect(syncs).toBe(1);
    expect(await getPendingOps(db)).toHaveLength(2);
  });

  test("submitReview resolves the uuid from the numeric id", async () => {
    const data = createLocalData(db, remote, () => {});
    await data.submitReview({ wordId: 11, rating: "easy" });
    const rows = await db.all("SELECT * FROM reviews");
    expect(rows[0].word_uuid).toBe("u1");
  });

  test("intervals preview covers all four ratings", async () => {
    const data = createLocalData(db, remote, () => {});
    const preview = await data.getIntervals(11);
    expect(preview.algorithm).toBe("sm2");
    expect(Object.keys(preview.intervals).sort()).toEqual([
      "again",
      "easy",
      "good",
      "hard",
    ]);
  });

  test("translate caches online results and serves them offline", async () => {
    const data = createLocalData(db, remote, () => {});
    const first = await data.translate({
      word: "apple",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(remoteCalls).toEqual(["translate"]);
    expect(first.translation).toBe("蘋果");

    const second = await data.translate({
      word: "APPLE",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(second.translation).toBe("蘋果");
    expect(remoteCalls).toEqual(["translate"]);
  });

  test("settings round-trip through the local meta table", async () => {
    const data = createLocalData(db, remote, () => {});
    expect((await data.getSettings()).srsAlgorithm).toBe("sm2");
    await data.setSettings({ srsAlgorithm: "fsrs" });
    expect((await data.getSettings()).srsAlgorithm).toBe("fsrs");
  });

  test("saveWord delegates to the remote API while online", async () => {
    const data = createLocalData(db, remote, () => {});
    await data.saveWord({
      word: "pear",
      translation: "梨",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(remoteCalls).toEqual(["saveWord"]);
  });
});
