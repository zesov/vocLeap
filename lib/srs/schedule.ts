import {
  formatDateForDB,
  parseRating,
  sm2Algorithm,
} from "./sm2";
import {
  fsrsStateToColumns,
  fsrsStateToSnapshot,
  RATING_TO_SM2_SCALE,
  scheduleWithFsrs,
  seedFsrsStateFromSm2,
  type FsrsState,
  type RatingName,
  type ReviewStateSnapshot,
} from "./fsrs";

export interface ScheduleReviewInput {
  algorithm: "sm2" | "fsrs";
  review: {
    easeFactor: number;
    interval: number;
    repetitions: number;
    nextReviewDate?: string | null;
    lastReviewed?: string | null;
    fsrsState?: FsrsState;
  } | null;
  rating: RatingName;
  timezone?: string;
  now?: Date;
}

export interface ScheduleReviewResult {
  review: {
    easeFactor: number;
    interval: number;
    repetitions: number;
    nextReviewDate: string;
    lastReviewed: string;
    fsrs?: {
      stability: number;
      difficulty: number;
      state: number;
      lapses: number;
      reps: number;
      lastReview: string | null;
    };
  };
  history: {
    rating: number;
    previousEaseFactor: number;
    previousInterval: number;
    previousRepetitions: number;
    newEaseFactor: number;
    newInterval: number;
    newRepetitions: number;
    algorithm: "sm2" | "fsrs";
    snapshot?: { before: ReviewStateSnapshot; after: ReviewStateSnapshot };
  };
  /** Response body fields, without `wordId` (added by each caller). */
  response: Record<string, unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveFsrsState(
  review: ScheduleReviewInput["review"]
): FsrsState {
  if (review?.fsrsState) return review.fsrsState;
  return seedFsrsStateFromSm2({
    easeFactor: review?.easeFactor ?? 2.5,
    interval: review?.interval ?? 0,
    repetitions: review?.repetitions ?? 0,
    nextReviewDate: review?.nextReviewDate ?? null,
    lastReviewed: review?.lastReviewed ?? null,
  });
}

export function scheduleReview(
  input: ScheduleReviewInput
): ScheduleReviewResult {
  const now = input.now ?? new Date();
  const review = input.review;
  const previousEaseFactor = review?.easeFactor ?? 2.5;
  const previousInterval = review?.interval ?? 0;
  const previousRepetitions = review?.repetitions ?? 0;

  if (input.algorithm === "fsrs") {
    const previousState = resolveFsrsState(review);
    const nextState = scheduleWithFsrs(previousState, input.rating, now);
    const columns = fsrsStateToColumns(nextState);
    const intervalDays = Math.max(
      1,
      Math.round((nextState.due.getTime() - now.getTime()) / DAY_MS)
    );

    return {
      review: {
        easeFactor: previousEaseFactor,
        interval: previousInterval,
        repetitions: previousRepetitions,
        nextReviewDate: formatDateForDB(nextState.due),
        lastReviewed: formatDateForDB(now),
        fsrs: {
          stability: columns.stability,
          difficulty: columns.difficulty,
          state: columns.fsrsState,
          lapses: columns.lapses,
          reps: columns.reps,
          lastReview: columns.lastReview,
        },
      },
      history: {
        rating: RATING_TO_SM2_SCALE[input.rating],
        previousEaseFactor,
        previousInterval,
        previousRepetitions,
        newEaseFactor: 0,
        newInterval: intervalDays,
        newRepetitions: nextState.reps,
        algorithm: "fsrs",
        snapshot: {
          before: fsrsStateToSnapshot(previousState),
          after: fsrsStateToSnapshot(nextState),
        },
      },
      response: {
        easeFactor: previousEaseFactor,
        interval: intervalDays,
        repetitions: nextState.reps,
        nextReviewDate: formatDateForDB(nextState.due),
        algorithm: "fsrs",
        fsrs: {
          stability: nextState.stability,
          difficulty: nextState.difficulty,
          state: nextState.state,
          lapses: nextState.lapses,
          reps: nextState.reps,
        },
      },
    };
  }

  const result = sm2Algorithm({
    easeFactor: previousEaseFactor,
    interval: previousInterval,
    repetitions: previousRepetitions,
    rating: parseRating(input.rating),
    timezone: input.timezone,
    now,
  });

  return {
    review: {
      easeFactor: result.easeFactor,
      interval: result.interval,
      repetitions: result.repetitions,
      nextReviewDate: formatDateForDB(result.nextReviewDate),
      lastReviewed: formatDateForDB(now),
    },
    history: {
      rating: parseRating(input.rating),
      previousEaseFactor,
      previousInterval,
      previousRepetitions,
      newEaseFactor: result.easeFactor,
      newInterval: result.interval,
      newRepetitions: result.repetitions,
      algorithm: "sm2",
    },
    response: {
      easeFactor: result.easeFactor,
      interval: result.interval,
      repetitions: result.repetitions,
      nextReviewDate: formatDateForDB(result.nextReviewDate),
    },
  };
}
