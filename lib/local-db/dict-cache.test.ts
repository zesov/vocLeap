import { beforeEach, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "./executor";
import { createNodeExecutor } from "./testing/executor";
import { migrateLocalSchema } from "./schema";
import {
  cacheKey,
  clearDictCache,
  getCachedDefinition,
  putCachedDefinition,
} from "./dict-cache";

let db: SqlExecutor;

const RESULT = {
  word: "apple",
  translation: "蘋果",
  definitions: [
    { partOfSpeech: "noun", definition: "a fruit", examples: ["I ate an apple"] },
  ],
  phonetic: "/ˈæp.əl/",
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
};

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
});

describe("dict cache", () => {
  test("cache keys are case-insensitive but language aware", () => {
    expect(cacheKey("Apple", "en", "zh-CN")).toBe(cacheKey("apple", "en", "zh-CN"));
    expect(cacheKey("apple", "en", "zh-CN")).not.toBe(cacheKey("apple", "en", "ja"));
  });

  test("stores and reads a definition", async () => {
    await putCachedDefinition(db, RESULT);
    const cached = await getCachedDefinition(db, "APPLE", "en", "zh-CN");
    expect(cached).toEqual(RESULT);
  });

  test("returns null for a miss", async () => {
    expect(await getCachedDefinition(db, "pear", "en", "zh-CN")).toBeNull();
  });

  test("overwrites an existing entry", async () => {
    await putCachedDefinition(db, RESULT);
    await putCachedDefinition(db, { ...RESULT, translation: "蘋果（更新）" });
    const cached = await getCachedDefinition(db, "apple", "en", "zh-CN");
    expect(cached?.translation).toBe("蘋果（更新）");
  });

  test("survives a corrupt payload", async () => {
    await db.run(
      "INSERT INTO dict_cache (cache_key, payload, fetched_at) VALUES ('en:zh-CN:apple', 'not json', '2026-11-10T00:00:00.000Z')"
    );
    expect(await getCachedDefinition(db, "apple", "en", "zh-CN")).toBeNull();
  });

  test("clears the cache", async () => {
    await putCachedDefinition(db, RESULT);
    await clearDictCache(db);
    expect(await getCachedDefinition(db, "apple", "en", "zh-CN")).toBeNull();
  });
});
