import { describe, expect, test } from "bun:test";
import { State } from "ts-fsrs";
import {
  RATING_TO_FSRS_GRADE,
  RATING_TO_SM2_SCALE,
  fsrsStateFromColumns,
  fsrsStateToColumns,
  previewFsrsIntervals,
  scheduleWithFsrs,
  seedFsrsStateFromSm2,
  type FsrsState,
} from "./fsrs";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

function seededSm2State() {
  const lastReviewed = new Date(Date.now() - 10 * DAY_MS);
  const nextReviewDate = new Date(Date.now() + 1 * DAY_MS);
  return {
    easeFactor: 2.5,
    interval: 10,
    repetitions: 3,
    nextReviewDate: nextReviewDate.toISOString(),
    lastReviewed: lastReviewed.toISOString(),
  };
}

describe("RATING_TO_FSRS_GRADE", () => {
  test("maps UI rating names to ts-fsrs grades 1-4", () => {
    expect(RATING_TO_FSRS_GRADE.again).toBe(1);
    expect(RATING_TO_FSRS_GRADE.hard).toBe(2);
    expect(RATING_TO_FSRS_GRADE.good).toBe(3);
    expect(RATING_TO_FSRS_GRADE.easy).toBe(4);
  });
});

describe("RATING_TO_SM2_SCALE", () => {
  test("maps UI rating names to the same 0/3/4/5 scale used by SM-2 history", () => {
    expect(RATING_TO_SM2_SCALE.again).toBe(0);
    expect(RATING_TO_SM2_SCALE.hard).toBe(3);
    expect(RATING_TO_SM2_SCALE.good).toBe(4);
    expect(RATING_TO_SM2_SCALE.easy).toBe(5);
  });
});

describe("seedFsrsStateFromSm2", () => {
  test("never-reviewed word becomes an empty New card", () => {
    const seeded = seedFsrsStateFromSm2({
      easeFactor: 2.5,
      interval: 0,
      repetitions: 0,
      nextReviewDate: new Date().toISOString(),
      lastReviewed: null,
    });
    expect(seeded.state).toBe(State.New);
    expect(seeded.stability).toBe(0);
    expect(seeded.difficulty).toBe(0);
    expect(seeded.reps).toBe(0);
    expect(seeded.lapses).toBe(0);
  });

  test("reviewed word: stability approximates the SM-2 interval at 0.9 retention", () => {
    const seeded = seedFsrsStateFromSm2(seededSm2State());
    expect(seeded.state).toBe(State.Review);
    expect(seeded.stability).toBeGreaterThanOrEqual(9.5);
    expect(seeded.stability).toBeLessThanOrEqual(10.5);
    expect(seeded.reps).toBe(3);
    expect(seeded.lapses).toBe(0);
  });

  test("reviewed word: difficulty derives from ease factor, clamped to 1-10", () => {
    const seeded = seedFsrsStateFromSm2(seededSm2State());
    expect(seeded.difficulty).toBeGreaterThan(1);
    expect(seeded.difficulty).toBeLessThan(10);
    // Higher ease factor (easier card) must produce lower difficulty.
    const easier = seedFsrsStateFromSm2({ ...seededSm2State(), easeFactor: 3.2 });
    expect(easier.difficulty).toBeLessThan(seeded.difficulty);
  });

  test("card with interval but zero repetitions still becomes a Review-state card", () => {
    const seeded = seedFsrsStateFromSm2({
      easeFactor: 1.9,
      interval: 4,
      repetitions: 0,
      nextReviewDate: new Date().toISOString(),
      lastReviewed: new Date(Date.now() - 4 * DAY_MS).toISOString(),
    });
    expect(seeded.state).toBe(State.Review);
    expect(seeded.stability).toBeGreaterThanOrEqual(3.5);
  });
});

describe("scheduleWithFsrs", () => {
  test("first review of a new card with Good schedules ~3 days ahead at Review state", () => {
    const next = scheduleWithFsrs(null, "good");
    expect(next.state).toBe(State.Review);
    expect(next.reps).toBe(1);
    const days = daysBetween(new Date(), next.due);
    expect(days).toBeGreaterThan(2);
    expect(days).toBeLessThanOrEqual(3.2);
  });

  test("Again on a Review-state card lapses and reschedules for the next day", () => {
    const prev = seedFsrsStateFromSm2(seededSm2State());
    const next = scheduleWithFsrs(prev, "again");
    expect(next.lapses).toBe(1);
    expect(next.state).toBe(State.Review);
    const days = daysBetween(new Date(), next.due);
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThanOrEqual(1.2);
  });

  test("successful ratings grow the interval monotonically again < hard < good < easy", () => {
    const prev = seedFsrsStateFromSm2(seededSm2State());
    const again = scheduleWithFsrs(prev, "again");
    const hard = scheduleWithFsrs(prev, "hard");
    const good = scheduleWithFsrs(prev, "good");
    const easy = scheduleWithFsrs(prev, "easy");

    const againDays = daysBetween(new Date(), again.due);
    const hardDays = daysBetween(new Date(), hard.due);
    const goodDays = daysBetween(new Date(), good.due);
    const easyDays = daysBetween(new Date(), easy.due);

    expect(hardDays).toBeGreaterThan(againDays);
    expect(goodDays).toBeGreaterThan(hardDays);
    expect(easyDays).toBeGreaterThan(goodDays);
  });

  test("previous state is never mutated", () => {
    const prev = seedFsrsStateFromSm2(seededSm2State());
    const before = { ...prev };
    scheduleWithFsrs(prev, "good");
    expect(prev).toEqual(before);
  });
});

describe("previewFsrsIntervals", () => {
  test("returns positive intervals for all four ratings without mutating input", () => {
    const prev = seedFsrsStateFromSm2(seededSm2State());
    const snapshot = { ...prev };
    const preview = previewFsrsIntervals(prev);

    expect(preview.again).toBeGreaterThan(0);
    expect(preview.hard).toBeGreaterThan(0);
    expect(preview.good).toBeGreaterThan(0);
    expect(preview.easy).toBeGreaterThan(0);
    expect(preview.again).toBeLessThan(preview.hard);
    expect(preview.hard).toBeLessThan(preview.good);
    expect(preview.good).toBeLessThan(preview.easy);
    expect(prev).toEqual(snapshot);
  });

  test("null state previews as a new card", () => {
    const preview = previewFsrsIntervals(null);
    expect(preview.good).toBeGreaterThan(0);
    expect(preview.easy).toBeGreaterThan(preview.good);
  });
});

describe("fsrsStateToColumns / fsrsStateFromColumns round-trip", () => {
  test("survives a serialise -> parse round trip", () => {
    const state: FsrsState = scheduleWithFsrs(
      seedFsrsStateFromSm2(seededSm2State()),
      "good"
    );
    const columns = fsrsStateToColumns(state);
    // Simulate what the DB layer sees: ISO strings coming back from SQLite.
    const row = {
      stability: columns.stability,
      difficulty: columns.difficulty,
      fsrs_state: columns.fsrsState,
      lapses: columns.lapses,
      reps: columns.reps,
      fsrs_due: columns.due,
      fsrs_last_review: columns.lastReview,
    };
    const restored = fsrsStateFromColumns(row);
    expect(restored).not.toBeNull();
    expect(restored!.stability).toBeCloseTo(state.stability, 6);
    expect(restored!.difficulty).toBeCloseTo(state.difficulty, 6);
    expect(restored!.state).toBe(state.state);
    expect(restored!.lapses).toBe(state.lapses);
    expect(restored!.reps).toBe(state.reps);
    expect(restored!.due.getTime()).toBe(state.due.getTime());
    expect(restored!.lastReview?.getTime()).toBe(state.lastReview!.getTime());
  });

  test("returns null when FSRS columns are absent (never seeded word)", () => {
    expect(
      fsrsStateFromColumns({
        stability: null,
        difficulty: null,
        fsrs_state: null,
        lapses: null,
        reps: null,
        fsrs_due: null,
        fsrs_last_review: null,
      })
    ).toBeNull();
  });
});
