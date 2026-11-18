import type { DataApi } from "../data/api";
import { bumpDataVersion } from "../data/data-version";
import type { SqlExecutor } from "./executor";
import { listBareWords, updateWordLocal } from "./operations";
import { getMeta, setMeta } from "./schema";
import { requestSync } from "./sync/trigger";

/**
 * Enriches words that were saved bare while offline (empty translation):
 * after a successful sync cycle, translate the oldest ones, update the local
 * row + enqueue a word op in one batch, and let the next push carry them to
 * the server. Runs only while online, a few words per cycle, and gives up on
 * a word after five failures so a permanently untranslatable term cannot
 * hammer the translate API every 60 s forever.
 */

const BACKFILL_BATCH = 3;
const MAX_FAILURES = 5;
const FAILURES_KEY = "backfill_failures";

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function readFailureCounts(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") counts[key] = value;
    }
    return counts;
  } catch {
    return {};
  }
}

async function recordFailure(
  db: SqlExecutor,
  counts: Record<string, number>,
  uuid: string
): Promise<void> {
  counts[uuid] = (counts[uuid] ?? 0) + 1;
  await setMeta(db, FAILURES_KEY, JSON.stringify(counts));
}

/**
 * Returns how many words were enriched. Errors per word are swallowed and
 * counted; the next successful cycle retries them.
 */
export async function backfillBareWords(
  db: SqlExecutor,
  remote: Pick<DataApi, "translate">
): Promise<number> {
  if (isOffline()) return 0;

  const counts = readFailureCounts(await getMeta(db, FAILURES_KEY));
  const candidates = (await listBareWords(db, 20))
    .filter((word) => (counts[word.uuid] ?? 0) < MAX_FAILURES)
    .slice(0, BACKFILL_BATCH);
  if (candidates.length === 0) return 0;

  let filled = 0;
  for (const candidate of candidates) {
    try {
      const result = await remote.translate({
        word: candidate.word,
        sourceLanguage: candidate.sourceLanguage,
        targetLanguage: candidate.targetLanguage,
      });
      await updateWordLocal(db, candidate.uuid, {
        translation: result.translation,
        definitions: result.definitions.map((def) => def.definition),
        examples: result.definitions.flatMap((def) => def.examples),
        phonetic: result.phonetic,
        audioUrl: result.audioUrl,
      });
      filled += 1;
    } catch {
      // Timeouts count as failures too: on a flaky network the next cycle
      // retries, and the MAX_FAILURES cap eventually stops the hammering.
      await recordFailure(db, counts, candidate.uuid).catch(() => {});
    }
  }

  if (filled > 0) {
    bumpDataVersion();
    requestSync();
  }
  return filled;
}
