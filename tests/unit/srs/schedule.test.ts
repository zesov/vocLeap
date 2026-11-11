import { describe, expect, test } from "bun:test";
import { scheduleReview } from "../../../lib/srs/schedule";

const NOW = new Date("2026-11-10T10:00:00.000Z");

describe("scheduleReview (SM-2)", () => {
  test("first good review schedules one day out", () => {
    const result = scheduleReview({
      algorithm: "sm2",
      review: null,
      rating: "good",
      now: NOW,
      timezone: "UTC",
    });
    expect(result.review.interval).toBe(1);
    expect(result.review.repetitions).toBe(1);
    expect(result.history.previousInterval).toBe(0);
    expect(result.history.newInterval).toBe(1);
    expect(result.history.algorithm).toBe("sm2");
    expect(result.response).toMatchObject({ interval: 1, repetitions: 1 });
  });

  test("again resets repetitions", () => {
    const result = scheduleReview({
      algorithm: "sm2",
      review: {
        easeFactor: 2.5,
        interval: 6,
        repetitions: 2,
        nextReviewDate: "2026-11-10 00:00:00",
        lastReviewed: "2026-11-04 10:00:00",
      },
      rating: "again",
      now: NOW,
      timezone: "UTC",
    });
    expect(result.review.repetitions).toBe(0);
    expect(result.review.interval).toBe(1);
  });
});

describe("scheduleReview (FSRS)", () => {
  test("returns fsrs columns and a snapshot", () => {
    const result = scheduleReview({
      algorithm: "fsrs",
      review: null,
      rating: "good",
      now: NOW,
      timezone: "UTC",
    });
    expect(result.review.fsrs).toBeDefined();
    expect(result.history.algorithm).toBe("fsrs");
    expect(result.history.snapshot?.after.stability).toBeGreaterThan(0);
    expect(result.response).toMatchObject({ algorithm: "fsrs" });
  });
});
