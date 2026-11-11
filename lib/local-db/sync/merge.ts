import type { PullPage } from "../../sync/server-pull";
import type { WordPayload } from "../../sync/types";
import type { SqlExecutor, SqlStep } from "../executor";
import { setMeta } from "../schema";
import { pendingReviewWordUuids, pendingWordUuids } from "./oplog";

export interface MergeStats {
  words: number;
  reviews: number;
  history: number;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function isNewer(incoming: string, local: string): boolean {
  const a = Date.parse(incoming);
  const b = Date.parse(local);
  if (Number.isNaN(a) || Number.isNaN(b)) return incoming > local;
  return a > b;
}

function wordColumns(payload: WordPayload) {
  return [
    payload.word,
    payload.translation,
    JSON.stringify(payload.definitions ?? []),
    JSON.stringify(payload.examples ?? []),
    payload.phonetic,
    payload.audioUrl,
    payload.sourceLanguage,
    payload.targetLanguage,
    payload.updatedAt,
    payload.deletedAt,
  ];
}

export async function mergePullPage(
  db: SqlExecutor,
  page: PullPage
): Promise<MergeStats> {
  const pendingWords = await pendingWordUuids(db);
  const pendingReviews = await pendingReviewWordUuids(db);
  const stats: MergeStats = { words: 0, reviews: 0, history: 0 };
  const steps: SqlStep[] = [];

  const incomingWordUuids = page.words.map((row) => row.uuid);
  const localWordRows =
    incomingWordUuids.length > 0
      ? await db.all<{
          uuid: string;
          server_id: number | null;
          updated_at: string;
          deleted_at: string | null;
        }>(
          `SELECT uuid, server_id, updated_at, deleted_at FROM words
           WHERE uuid IN (${placeholders(incomingWordUuids.length)})`,
          incomingWordUuids
        )
      : [];
  const localWords = new Map(localWordRows.map((row) => [row.uuid, row]));

  const knownWordUuids = new Set(incomingWordUuids);
  for (const row of await db.all<{ uuid: string }>("SELECT uuid FROM words")) {
    knownWordUuids.add(row.uuid);
  }

  for (const payload of page.words) {
    if (pendingWords.has(payload.uuid)) continue;

    const local = localWords.get(payload.uuid);
    if (!local) {
      steps.push({
        sql: `INSERT INTO words (
                uuid, server_id, word, translation, definitions, examples,
                phonetic, audio_url, source_language, target_language,
                created_at, updated_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(uuid) DO NOTHING`,
        params: [
          payload.uuid,
          payload.serverId ?? null,
          ...wordColumns(payload).slice(0, 8),
          payload.createdAt,
          payload.updatedAt,
          payload.deletedAt,
        ],
      });
      stats.words += 1;
      continue;
    }

    if (local.deleted_at !== null) continue;
    if (!isNewer(payload.updatedAt, local.updated_at)) {
      // A locally-created word echoes back with the timestamp we pushed, so the
      // row is not newer but still needs the server id the insert assigned.
      if (payload.serverId != null && local.server_id == null) {
        steps.push({
          sql: "UPDATE words SET server_id = ? WHERE uuid = ? AND server_id IS NULL",
          params: [payload.serverId, payload.uuid],
        });
        stats.words += 1;
      }
      continue;
    }

    steps.push({
      sql: `UPDATE words SET
              server_id = COALESCE(?, server_id),
              word = ?, translation = ?, definitions = ?, examples = ?,
              phonetic = ?, audio_url = ?, source_language = ?,
              target_language = ?, updated_at = ?, deleted_at = ?
            WHERE uuid = ?`,
      params: [payload.serverId ?? null, ...wordColumns(payload), payload.uuid],
    });
    stats.words += 1;
  }

  const incomingReviewUuids = page.reviews.map((row) => row.wordUuid);
  const localReviewRows =
    incomingReviewUuids.length > 0
      ? await db.all<{ word_uuid: string; updated_at: string }>(
          `SELECT word_uuid, updated_at FROM reviews
           WHERE word_uuid IN (${placeholders(incomingReviewUuids.length)})`,
          incomingReviewUuids
        )
      : [];
  const localReviews = new Map(
    localReviewRows.map((row) => [row.word_uuid, row.updated_at])
  );

  for (const payload of page.reviews) {
    if (pendingReviews.has(payload.wordUuid)) continue;
    if (!knownWordUuids.has(payload.wordUuid)) continue;

    const localUpdatedAt = localReviews.get(payload.wordUuid);
    if (localUpdatedAt && !isNewer(payload.updatedAt, localUpdatedAt)) continue;

    steps.push({
      sql: `INSERT INTO reviews (
              word_uuid, ease_factor, interval, repetitions, next_review_date,
              last_reviewed, stability, difficulty, fsrs_state, lapses,
              fsrs_reps, fsrs_last_review, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(word_uuid) DO UPDATE SET
              ease_factor = excluded.ease_factor,
              interval = excluded.interval,
              repetitions = excluded.repetitions,
              next_review_date = excluded.next_review_date,
              last_reviewed = excluded.last_reviewed,
              stability = excluded.stability,
              difficulty = excluded.difficulty,
              fsrs_state = excluded.fsrs_state,
              lapses = excluded.lapses,
              fsrs_reps = excluded.fsrs_reps,
              fsrs_last_review = excluded.fsrs_last_review,
              updated_at = excluded.updated_at`,
      params: [
        payload.wordUuid,
        payload.easeFactor,
        payload.interval,
        payload.repetitions,
        payload.nextReviewDate,
        payload.lastReviewed,
        payload.stability,
        payload.difficulty,
        payload.fsrsState,
        payload.lapses,
        payload.fsrsReps,
        payload.fsrsLastReview,
        payload.updatedAt,
      ],
    });
    stats.reviews += 1;
  }

  const incomingHistoryUuids = page.history.map((row) => row.uuid);
  const localHistoryRows =
    incomingHistoryUuids.length > 0
      ? await db.all<{ uuid: string }>(
          `SELECT uuid FROM review_history
           WHERE uuid IN (${placeholders(incomingHistoryUuids.length)})`,
          incomingHistoryUuids
        )
      : [];
  const knownHistoryUuids = new Set(localHistoryRows.map((row) => row.uuid));

  for (const payload of page.history) {
    if (!knownWordUuids.has(payload.wordUuid)) continue;
    if (knownHistoryUuids.has(payload.uuid)) continue;
    knownHistoryUuids.add(payload.uuid);
    steps.push({
      sql: `INSERT INTO review_history (
              uuid, word_uuid, rating, previous_ease_factor,
              previous_interval, previous_repetitions, new_ease_factor,
              new_interval, new_repetitions, algorithm, snapshot, reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(uuid) DO NOTHING`,
      params: [
        payload.uuid,
        payload.wordUuid,
        payload.rating,
        payload.previousEaseFactor,
        payload.previousInterval,
        payload.previousRepetitions,
        payload.newEaseFactor,
        payload.newInterval,
        payload.newRepetitions,
        payload.algorithm,
        payload.snapshot === null || payload.snapshot === undefined
          ? null
          : JSON.stringify(payload.snapshot),
        payload.reviewedAt,
      ],
    });
    stats.history += 1;
  }

  if (steps.length > 0) {
    await db.batch(steps);
  }

  const pendingSettings = await db.all<{ count: number }>(
    "SELECT COUNT(*) AS count FROM sync_ops WHERE entity = 'settings'"
  );
  if (Number(pendingSettings[0]?.count ?? 0) === 0) {
    await setMeta(db, "srs_algorithm", page.settings.srsAlgorithm);
  }

  return stats;
}
