import type { DictionaryResult } from "../data/types";
import type { SqlExecutor } from "./executor";

export function cacheKey(
  word: string,
  sourceLanguage: string,
  targetLanguage: string
): string {
  return `${sourceLanguage}:${targetLanguage}:${word.trim().toLowerCase()}`;
}

export async function getCachedDefinition(
  db: SqlExecutor,
  word: string,
  sourceLanguage: string,
  targetLanguage: string
): Promise<DictionaryResult | null> {
  const rows = await db.all<{ payload: string }>(
    "SELECT payload FROM dict_cache WHERE cache_key = ?",
    [cacheKey(word, sourceLanguage, targetLanguage)]
  );
  const payload = rows[0]?.payload;
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as DictionaryResult;
    return parsed && typeof parsed.word === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function putCachedDefinition(
  db: SqlExecutor,
  result: DictionaryResult
): Promise<void> {
  await db.run(
    `INSERT INTO dict_cache (cache_key, payload, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload = excluded.payload, fetched_at = excluded.fetched_at`,
    [
      cacheKey(result.word, result.sourceLanguage, result.targetLanguage),
      JSON.stringify(result),
      new Date().toISOString(),
    ]
  );
}

export async function clearDictCache(db: SqlExecutor): Promise<void> {
  await db.run("DELETE FROM dict_cache");
}
