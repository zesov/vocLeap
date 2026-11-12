import type { SqlExecutor } from "../local-db/executor";
import { getCachedDefinition, putCachedDefinition } from "../local-db/dict-cache";
import {
  getAlgorithm,
  getDueReviews,
  getHistoryPage,
  getNewWords,
  getStats,
  getWordHistory,
  getWordsPage,
  setAlgorithmLocal,
} from "../local-db/operations";
import { getReviewState, submitReviewLocal } from "../local-db/submit-review";
import { previewFsrsIntervals } from "../srs/fsrs";
import { resolveFsrsState, scheduleReview } from "../srs/schedule";
import { resolveClientTimezone } from "../timezone";
import type { DataApi } from "./api";
import type { IntervalPreview, Rating, SrsAlgorithm } from "./types";

const RATINGS: Rating[] = ["again", "hard", "good", "easy"];

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

async function uuidForWordId(
  db: SqlExecutor,
  wordId: number
): Promise<string | null> {
  const rows = await db.all<{ uuid: string }>(
    "SELECT uuid FROM words WHERE server_id = ? AND deleted_at IS NULL",
    [wordId]
  );
  return rows[0]?.uuid ?? null;
}

export function createLocalData(
  db: SqlExecutor,
  remote: DataApi,
  onWrite: () => void = () => {}
): DataApi {
  const notify = () => {
    try {
      onWrite();
    } catch {
      // a failed sync trigger must never fail the local write
    }
  };

  return {
    getWords: ({ limit, offset, sort }) => getWordsPage(db, limit, offset, sort),

    getDueReviews: (limit) => getDueReviews(db, limit),

    getNewWords: (limit) => getNewWords(db, limit),

    getStats: () => getStats(db),

    getHistory: ({ limit, offset }) => getHistoryPage(db, limit, offset),

    async getWordHistory(wordId) {
      const uuid = await uuidForWordId(db, wordId);
      if (!uuid) return [];
      return getWordHistory(db, uuid);
    },

    async getSettings() {
      return { srsAlgorithm: await getAlgorithm(db) };
    },

    async getIntervals(wordId): Promise<IntervalPreview> {
      const uuid = await uuidForWordId(db, wordId);
      if (!uuid) throw new Error("Word not found");
      const algorithm: SrsAlgorithm = await getAlgorithm(db);
      const review = await getReviewState(db, uuid);
      const now = new Date();
      if (algorithm === "fsrs") {
        // Same math as the server's action=intervals handler: preview all
        // four grades from the FSRS state (seeded from the frozen SM-2
        // columns when the word has no FSRS rows yet). Reading the SM-2
        // interval column here would echo the same frozen value for every
        // rating.
        return {
          algorithm,
          intervals: previewFsrsIntervals(resolveFsrsState(review), now),
        };
      }
      const intervals = {} as Record<Rating, number>;
      for (const rating of RATINGS) {
        intervals[rating] = scheduleReview({
          algorithm,
          review,
          rating,
          now,
        }).review.interval;
      }
      return { algorithm, intervals };
    },

    async submitReview({ wordId, uuid, rating }) {
      const resolved = uuid ?? (await uuidForWordId(db, wordId));
      if (!resolved) throw new Error("Word not found");
      const result = await submitReviewLocal(db, {
        wordUuid: resolved,
        rating,
        timezone: resolveClientTimezone(undefined) ?? "UTC",
      });
      notify();
      return result;
    },

    async saveWord(input) {
      if (!isOnline()) {
        throw new Error("Adding new words is only available online");
      }
      const saved = await remote.saveWord(input);
      // Pull the server row back so the local queue sees the new word now
      // instead of at the next scheduled sync.
      notify();
      return saved;
    },

    async translate(input) {
      const cached = await getCachedDefinition(
        db,
        input.word,
        input.sourceLanguage,
        input.targetLanguage
      );
      if (cached) return cached;

      if (!isOnline()) {
        throw new Error("Offline and not cached");
      }
      try {
        const result = await remote.translate(input);
        await putCachedDefinition(db, result);
        return result;
      } catch (error) {
        // Re-check the cache: another call may have filled it concurrently.
        const raced = await getCachedDefinition(
          db,
          input.word,
          input.sourceLanguage,
          input.targetLanguage
        );
        if (raced) return raced;
        throw error;
      }
    },

    async setSettings(input) {
      await setAlgorithmLocal(db, input.srsAlgorithm);
      notify();
      return { srsAlgorithm: input.srsAlgorithm };
    },
  };
}
