import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  State,
  type Card,
  type CardInput,
  type FSRSParameters,
  type Grade,
} from "ts-fsrs";

export type RatingName = "again" | "hard" | "good" | "easy";

export interface FsrsState {
  stability: number;
  difficulty: number;
  state: number;
  lapses: number;
  reps: number;
  due: Date;
  lastReview: Date | null;
}

export interface FsrsColumns {
  stability: number;
  difficulty: number;
  fsrsState: number;
  lapses: number;
  reps: number;
  due: string;
  lastReview: string | null;
}

export interface ReviewStateSnapshot {
  stability: number;
  difficulty: number;
  state: number;
  lapses: number;
  reps: number;
  due: string;
}

export interface Sm2SeedInput {
  easeFactor: number;
  interval: number;
  repetitions: number;
  nextReviewDate: string | null;
  lastReviewed: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_RETENTION = 0.9;

const parameters: FSRSParameters = generatorParameters({
  enable_short_term: false,
  request_retention: REQUEST_RETENTION,
});
const scheduler = fsrs(parameters);

export const RATING_TO_FSRS_GRADE: Record<RatingName, Grade> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};

export const RATING_TO_SM2_SCALE: Record<RatingName, number> = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toISO(date: Date): string {
  return date.toISOString();
}

/** DB DATETIME columns hold UTC without a zone marker ("YYYY-MM-DD HH:MM:SS").
 * `new Date(...)` reads such strings as server-LOCAL time, which would shift
 * every stored instant on non-UTC servers, so normalize them to ISO UTC
 * first. Strings that already carry a zone (ISO snapshots) parse as-is. */
const ZONELESS_DB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function parseDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  const normalized = ZONELESS_DB_TIMESTAMP.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cardToState(card: Card): FsrsState {
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    state: card.state as number,
    lapses: card.lapses,
    reps: card.reps,
    due: card.due,
    lastReview: card.last_review ?? null,
  };
}

function stateToCardInput(state: FsrsState): CardInput {
  return {
    due: state.due,
    stability: state.stability,
    difficulty: state.difficulty,
    scheduled_days: 0,
    learning_steps: 0,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state as State,
    last_review: state.lastReview ?? undefined,
  };
}

function difficultyFromEase(easeFactor: number, stability: number): number {
  const { w } = parameters;
  const denominator =
    Math.exp(w[8]) *
    Math.pow(stability, -w[9]) *
    (Math.exp(w[10] * (1 - REQUEST_RETENTION)) - 1);
  if (!Number.isFinite(denominator) || denominator <= 0) return 5;
  return 11 - (easeFactor - 1) / denominator;
}

export function seedFsrsStateFromSm2(sm2: Sm2SeedInput): FsrsState {
  const { easeFactor, interval, repetitions, nextReviewDate, lastReviewed } = sm2;

  if (repetitions === 0 && interval === 0) {
    return cardToState(
      createEmptyCard(parseDateOrNull(nextReviewDate) ?? new Date())
    );
  }

  const stability = Math.max(interval, 0.1);
  const difficulty = clamp(difficultyFromEase(easeFactor, stability), 1, 10);

  return {
    stability,
    difficulty,
    state: State.Review,
    lapses: 0,
    reps: repetitions,
    due: parseDateOrNull(nextReviewDate) ?? new Date(),
    lastReview: parseDateOrNull(lastReviewed),
  };
}

export function scheduleWithFsrs(
  prev: FsrsState | null,
  rating: RatingName,
  now: Date = new Date()
): FsrsState {
  const card = prev ? stateToCardInput(prev) : createEmptyCard(now);
  const result = scheduler.next(card, now, RATING_TO_FSRS_GRADE[rating]);
  return cardToState(result.card);
}

export function previewFsrsIntervals(
  prev: FsrsState | null,
  now: Date = new Date()
): Record<RatingName, number> {
  const ratings: RatingName[] = ["again", "hard", "good", "easy"];
  const preview = {} as Record<RatingName, number>;
  for (const rating of ratings) {
    const next = scheduleWithFsrs(prev, rating, now);
    preview[rating] =
      Math.round(((next.due.getTime() - now.getTime()) / DAY_MS) * 100) / 100;
  }
  return preview;
}

export function fsrsStateToSnapshot(state: FsrsState): ReviewStateSnapshot {
  return {
    stability: state.stability,
    difficulty: state.difficulty,
    state: state.state,
    lapses: state.lapses,
    reps: state.reps,
    due: toISO(state.due),
  };
}

export function fsrsStateToColumns(state: FsrsState): FsrsColumns {
  return {
    stability: state.stability,
    difficulty: state.difficulty,
    fsrsState: state.state,
    lapses: state.lapses,
    reps: state.reps,
    due: toISO(state.due),
    lastReview: state.lastReview ? toISO(state.lastReview) : null,
  };
}

export function fsrsStateFromColumns(row: {
  stability: unknown;
  difficulty: unknown;
  fsrs_state: unknown;
  lapses: unknown;
  reps: unknown;
  fsrs_due: unknown;
  fsrs_last_review: unknown;
}): FsrsState | null {
  if (
    row.stability === null ||
    row.stability === undefined ||
    row.difficulty === null ||
    row.difficulty === undefined ||
    row.fsrs_state === null ||
    row.fsrs_state === undefined
  ) {
    return null;
  }

  const due = parseDateOrNull(row.fsrs_due) ?? new Date();
  return {
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    state: Number(row.fsrs_state),
    lapses: row.lapses === null || row.lapses === undefined ? 0 : Number(row.lapses),
    reps: row.reps === null || row.reps === undefined ? 0 : Number(row.reps),
    due,
    lastReview: parseDateOrNull(row.fsrs_last_review),
  };
}
