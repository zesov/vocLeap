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

interface LocalWordRow {
  uuid: string;
  server_id: number | null;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Composite key for history deduplication: (word_uuid, reviewed_at, rating).
 * The server generates UUIDs, but the client also generates UUIDs locally
 * before push. If both exist for the same review, we'd get duplicates.
 * Using a composite key avoids this.
 * Accepts both camelCase (from pull page) and snake_case (from DB).
 */
function historyCompositeKey(payload: { wordUuid?: string; word_uuid?: string; reviewedAt?: string; reviewed_at?: string; rating: number }): string {
  const wordUuid = payload.wordUuid ?? payload.word_uuid!;
  const reviewedAt = payload.reviewedAt ?? payload.reviewed_at!;
  return `${wordUuid}|${reviewedAt}|${payload.rating}`;
}

/**
 * Adopts a locally-created duplicate under the server's surviving uuid:
 * remaps its reviews (last-reviewed LWW) and history, rewrites any still
 * pending review/history ops so they reference the surviving uuid (the
 * server no longer knows the old one — without this a queued review op
 * would be rejected and pause sync), then removes the duplicate row.
 */
function adoptionSteps(payload: WordPayload, dupUuid: string): SqlStep[] {
  return [
    {
      sql: `INSERT INTO reviews (
              word_uuid, ease_factor, interval, repetitions, next_review_date,
              last_reviewed, stability, difficulty, fsrs_state, lapses,
              fsrs_reps, fsrs_last_review, updated_at
            )
            SELECT ?, ease_factor, interval, repetitions, next_review_date,
              last_reviewed, stability, difficulty, fsrs_state, lapses,
              fsrs_reps, fsrs_last_review, updated_at
            FROM reviews WHERE word_uuid = ?
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
              updated_at = excluded.updated_at
            WHERE COALESCE(excluded.last_reviewed, '') > COALESCE(reviews.last_reviewed, '')`,
      params: [payload.uuid, dupUuid],
    },
    {
      sql: "DELETE FROM reviews WHERE word_uuid = ?",
      params: [dupUuid],
    },
    {
      sql: "UPDATE review_history SET word_uuid = ? WHERE word_uuid = ?",
      params: [payload.uuid, dupUuid],
    },
    {
      sql: `UPDATE sync_ops SET payload = json_set(payload, '$.wordUuid', ?)
            WHERE entity IN ('review', 'history')
              AND json_extract(payload, '$.wordUuid') = ?`,
      params: [payload.uuid, dupUuid],
    },
    {
      sql: "DELETE FROM words WHERE uuid = ?",
      params: [dupUuid],
    },
  ];
}

export async function mergePullPage(
  db: SqlExecutor,
  page: PullPage
): Promise<MergeStats> {
  const pendingWords = await pendingWordUuids(db);
  const pendingReviews = await pendingReviewWordUuids(db);
  const stats: MergeStats = { words: 0, reviews: 0, history: 0 };

  // ---------------------------------------------------------------------------
  // PHASE 0: Load local state needed for all phases
  // ---------------------------------------------------------------------------
  const incomingWordUuids = page.words.map((row) => row.uuid);
  const localWordRows =
    incomingWordUuids.length > 0
      ? await db.all<LocalWordRow>(
          `SELECT uuid, server_id, updated_at, deleted_at FROM words
           WHERE uuid IN (${placeholders(incomingWordUuids.length)})`,
          incomingWordUuids
        )
      : [];
  const localWords = new Map<string, LocalWordRow>(localWordRows.map((row) => [row.uuid, row]));

  const knownWordUuids = new Set(incomingWordUuids);
  for (const row of await db.all<{ uuid: string }>("SELECT uuid FROM words")) {
    knownWordUuids.add(row.uuid);
  }

  // Cross-device duplicate detection: two devices can create the same word
  // offline under different uuids. The server folds the pushed copy into the
  // row it already owns, so the pull delivers the surviving uuid while the
  // local file still holds the locally-created one. Match those rows by word
  // text so they can be adopted (below) instead of turning into duplicates.
  const incomingTexts = [...new Set(page.words.map((row) => row.word))];
  const duplicateRows =
    incomingTexts.length > 0
      ? await db.all<{
          uuid: string;
          word: string;
          server_id: number | null;
          updated_at: string;
          deleted_at: string | null;
        }>(
          `SELECT uuid, word, server_id, updated_at, deleted_at FROM words
           WHERE word IN (${placeholders(incomingTexts.length)})`,
          incomingTexts
        )
      : [];
  const duplicatesByText = new Map<string, typeof duplicateRows>();
  for (const row of duplicateRows) {
    const list = duplicatesByText.get(row.word) ?? [];
    list.push(row);
    duplicatesByText.set(row.word, list);
  }
  const otherTextRows = (payload: WordPayload) =>
    (duplicatesByText.get(payload.word) ?? []).filter(
      (row) => row.uuid !== payload.uuid && row.deleted_at === null
    );

  // ---------------------------------------------------------------------------
  // PHASE 1: Collect all adoptions needed (pre-pass before any inserts)
  // ---------------------------------------------------------------------------
  const adoptions: Array<{ payload: WordPayload; dupUuid: string }> = [];
  const reviewGuardTimestamps = new Map<string, string>();

  for (const payload of page.words) {
    if (pendingWords.has(payload.uuid)) continue;
    const otherRows = otherTextRows(payload);
    const dup = otherRows.find((row) => !pendingWords.has(row.uuid));
    const pendingDup = otherRows.find((row) => pendingWords.has(row.uuid));
    if (dup) {
      adoptions.push({ payload, dupUuid: dup.uuid });
      // The review LWW guard must know about rows that will be remapped by an
      // adoption below: a pending-adoption target uuid is not in the database yet
      // when the review guard map is built, so seed it with the duplicate's
      // last-review timestamp after the remap happens.
      reviewGuardTimestamps.set(payload.uuid, dup.uuid);
    } else if (pendingDup && !dup) {
      // A pending duplicate still occupies the word-text index (its op
      // has not pushed yet — e.g. a huge backlog past the push batch
      // cap). We'll skip this word in the insert/update phase and let the
      // next pull cycle handle it after the pending op pushes.
    }
  }

  // Execute all adoptions in ONE batch before any inserts/updates.
  // This clears the unique index on (word, deleted_at) so incoming rows can insert.
  if (adoptions.length > 0) {
    const adoptionStepList = adoptions.flatMap(({ payload, dupUuid }) => adoptionSteps(payload, dupUuid));
    await db.batch(adoptionStepList);
    // Update localWords map after adoptions so subsequent phases see the new state.
    // Only remove the duplicate uuid; the server word row will be inserted in PHASE 2.
    for (const { dupUuid } of adoptions) {
      localWords.delete(dupUuid);
    }
  }

  // ---------------------------------------------------------------------------
  // PHASE 2: Insert/update words (now that adoptions have cleared the index)
  // ---------------------------------------------------------------------------
  const wordSteps: SqlStep[] = [];
  for (const payload of page.words) {
    if (pendingWords.has(payload.uuid)) continue;

    const otherRows = otherTextRows(payload);
    const pendingDup = otherRows.find((row) => pendingWords.has(row.uuid));
    if (pendingDup) {
      // Still blocked by a pending op — skip this cycle.
      continue;
    }

    const local = localWords.get(payload.uuid);
    if (!local) {
      wordSteps.push({
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
        wordSteps.push({
          sql: "UPDATE words SET server_id = ? WHERE uuid = ? AND server_id IS NULL",
          params: [payload.serverId, payload.uuid],
        });
        stats.words += 1;
      }
      continue;
    }

    wordSteps.push({
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

  if (wordSteps.length > 0) {
    await db.batch(wordSteps);
  }

  // ---------------------------------------------------------------------------
  // PHASE 3: Merge reviews (LWW by last_reviewed)
  // ---------------------------------------------------------------------------
  const incomingReviewUuids = page.reviews.map((row) => row.wordUuid);
  const reviewGuardUuids = [
    ...new Set([
      ...incomingReviewUuids,
      ...reviewGuardTimestamps.keys(),
      ...reviewGuardTimestamps.values(),
    ]),
  ];
  const localReviewRows =
    reviewGuardUuids.length > 0
      ? await db.all<{ word_uuid: string; updated_at: string }>(
          `SELECT word_uuid, updated_at FROM reviews
           WHERE word_uuid IN (${placeholders(reviewGuardUuids.length)})`,
          reviewGuardUuids
        )
      : [];
  const localReviews = new Map(
    localReviewRows.map((row) => [row.word_uuid, row.updated_at])
  );
  for (const [targetUuid, dupUuid] of reviewGuardTimestamps) {
    const dupReview = localReviewRows.find((row) => row.word_uuid === dupUuid);
    if (dupReview) localReviews.set(targetUuid, dupReview.updated_at);
  }

  const reviewSteps: SqlStep[] = [];
  for (const payload of page.reviews) {
    if (pendingReviews.has(payload.wordUuid)) continue;
    if (!knownWordUuids.has(payload.wordUuid)) continue;

    const localUpdatedAt = localReviews.get(payload.wordUuid);
    if (localUpdatedAt && !isNewer(payload.updatedAt, localUpdatedAt)) continue;

    reviewSteps.push({
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

  if (reviewSteps.length > 0) {
    await db.batch(reviewSteps);
  }

  // ---------------------------------------------------------------------------
  // PHASE 4: Merge history (deduplicate by composite key, not just UUID)
  // ---------------------------------------------------------------------------
  // Load existing history composite keys to avoid duplicates where client
  // and server both generated UUIDs for the same review.
  const existingHistoryKeys = new Set<string>();
  if (page.history.length > 0) {
    const incomingWordUuidsForHistory = [...new Set(page.history.map((h) => h.wordUuid))];
    if (incomingWordUuidsForHistory.length > 0) {
      const existingRows = await db.all<{ word_uuid: string; reviewed_at: string; rating: number }>(
        `SELECT word_uuid, reviewed_at, rating FROM review_history
         WHERE word_uuid IN (${placeholders(incomingWordUuidsForHistory.length)})`,
        incomingWordUuidsForHistory
      );
      for (const row of existingRows) {
        existingHistoryKeys.add(historyCompositeKey(row));
      }
    }
  }

  const historySteps: SqlStep[] = [];
  for (const payload of page.history) {
    if (!knownWordUuids.has(payload.wordUuid)) continue;
    const key = historyCompositeKey(payload);
    if (existingHistoryKeys.has(key)) continue;
    existingHistoryKeys.add(key);

    historySteps.push({
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

  if (historySteps.length > 0) {
    await db.batch(historySteps);
  }

  // ---------------------------------------------------------------------------
  // PHASE 5: Settings
  // ---------------------------------------------------------------------------
  const pendingSettings = await db.all<{ count: number }>(
    "SELECT COUNT(*) AS count FROM sync_ops WHERE entity = 'settings'"
  );
  if (Number(pendingSettings[0]?.count ?? 0) === 0) {
    await setMeta(db, "srs_algorithm", page.settings.srsAlgorithm);
  }

  return stats;
}
