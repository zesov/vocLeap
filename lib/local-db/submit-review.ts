import type { Rating } from "../data/types";
import { fsrsStateFromColumns } from "../srs/fsrs";
import { scheduleReview } from "../srs/schedule";
import { formatDateForDB } from "../srs/sm2";
import { uuidv7 } from "../uuid";
import type { SqlExecutor, SqlStep } from "./executor";
import { getAlgorithm } from "./operations";
import { enqueueOpStep } from "./sync/oplog";

export interface SubmitReviewInput {
  wordUuid: string;
  rating: Rating;
  timezone?: string;
  /** Injectable clock so tests are deterministic. */
  now?: Date;
}

export interface SubmitReviewResult {
  wordId: number;
  response: Record<string, unknown>;
}

export async function getReviewState(
  db: SqlExecutor,
  wordUuid: string
): Promise<Parameters<typeof scheduleReview>[0]["review"]> {
  const rows = await db.all("SELECT * FROM reviews WHERE word_uuid = ?", [
    wordUuid,
  ]);
  const row = rows[0];
  if (!row) return null;

  const fsrsState =
    fsrsStateFromColumns({
      stability: row.stability as number | null,
      difficulty: row.difficulty as number | null,
      fsrs_state: row.fsrs_state as number | null,
      lapses: row.lapses as number | null,
      reps: row.fsrs_reps as number | null,
      fsrs_due: row.next_review_date as string,
      fsrs_last_review: row.fsrs_last_review as string | null,
    }) ?? undefined;

  return {
    easeFactor: Number(row.ease_factor),
    interval: Number(row.interval),
    repetitions: Number(row.repetitions),
    nextReviewDate: String(row.next_review_date),
    lastReviewed: row.last_reviewed == null ? null : String(row.last_reviewed),
    fsrsState,
  };
}

/**
 * Schedules a review entirely in the local database: review row, history row,
 * and the two sync ops, in one atomic batch.
 */
export async function submitReviewLocal(
  db: SqlExecutor,
  input: SubmitReviewInput
): Promise<SubmitReviewResult> {
  const words = await db.all<{ server_id: number | null; deleted_at: string | null }>(
    "SELECT server_id, deleted_at FROM words WHERE uuid = ?",
    [input.wordUuid]
  );
  const word = words[0];
  if (!word || word.deleted_at !== null) {
    throw new Error("Word not found");
  }

  const algorithm = await getAlgorithm(db);
  const previous = await getReviewState(db, input.wordUuid);
  const now = input.now ?? new Date();
  const scheduled = scheduleReview({
    algorithm,
    review: previous,
    rating: input.rating,
    timezone: input.timezone,
    now,
  });

  const reviewedAt = formatDateForDB(now);
  const historyUuid = uuidv7();
  const fsrs = scheduled.review.fsrs;

  const reviewOp = enqueueOpStep("review", "upsert", {
    wordUuid: input.wordUuid,
    easeFactor: scheduled.review.easeFactor,
    interval: scheduled.review.interval,
    repetitions: scheduled.review.repetitions,
    nextReviewDate: scheduled.review.nextReviewDate,
    lastReviewed: scheduled.review.lastReviewed,
    stability: fsrs?.stability ?? null,
    difficulty: fsrs?.difficulty ?? null,
    fsrsState: fsrs?.state ?? null,
    lapses: fsrs?.lapses ?? null,
    fsrsReps: fsrs?.reps ?? null,
    fsrsLastReview: fsrs?.lastReview ?? null,
    updatedAt: now.toISOString(),
  });

  const historyOp = enqueueOpStep("history", "upsert", {
    uuid: historyUuid,
    wordUuid: input.wordUuid,
    ...scheduled.history,
    snapshot: scheduled.history.snapshot ?? null,
    reviewedAt,
  });

  const steps: SqlStep[] = [
    {
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
        input.wordUuid,
        scheduled.review.easeFactor,
        scheduled.review.interval,
        scheduled.review.repetitions,
        scheduled.review.nextReviewDate,
        scheduled.review.lastReviewed,
        fsrs?.stability ?? null,
        fsrs?.difficulty ?? null,
        fsrs?.state ?? null,
        fsrs?.lapses ?? null,
        fsrs?.reps ?? null,
        fsrs?.lastReview ?? null,
        now.toISOString(),
      ],
    },
    {
      sql: `INSERT INTO review_history (
              uuid, word_uuid, rating, previous_ease_factor,
              previous_interval, previous_repetitions, new_ease_factor,
              new_interval, new_repetitions, algorithm, snapshot, reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        historyUuid,
        input.wordUuid,
        scheduled.history.rating,
        scheduled.history.previousEaseFactor,
        scheduled.history.previousInterval,
        scheduled.history.previousRepetitions,
        scheduled.history.newEaseFactor,
        scheduled.history.newInterval,
        scheduled.history.newRepetitions,
        scheduled.history.algorithm,
        scheduled.history.snapshot
          ? JSON.stringify(scheduled.history.snapshot)
          : null,
        reviewedAt,
      ],
    },
    reviewOp.step,
    historyOp.step,
  ];

  await db.batch(steps);

  const wordId = Number(word.server_id ?? 0);
  return {
    wordId,
    response: { wordId, ...scheduled.response },
  };
}
