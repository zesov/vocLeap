import { describe, expect, test } from "bun:test";
import { formatDateForDB, sm2Algorithm } from "../../../lib/srs/sm2";

const base = { easeFactor: 2.5, interval: 0, repetitions: 0, rating: 4 };

describe("sm2Algorithm next-review boundary", () => {
  test("with a timezone, due is the user's local midnight (+interval days)", () => {
    // 2026-11-09 12:00 UTC == 20:00 HKT
    const now = new Date("2026-11-09T12:00:00.000Z");
    const result = sm2Algorithm({ ...base, rating: 4, timezone: "Asia/Hong_Kong", now });
    // interval 1 -> 2026-11-10 00:00 HKT == 2026-11-09 16:00 UTC
    expect(result.interval).toBe(1);
    expect(formatDateForDB(result.nextReviewDate)).toBe("2026-11-09 16:00:00");
  });

  test("near the user's local midnight, the calendar day follows their zone", () => {
    // 2026-11-09 16:30 UTC == 2026-11-10 00:30 HKT: the user is already on Nov 10
    const now = new Date("2026-11-09T16:30:00.000Z");
    const result = sm2Algorithm({ ...base, rating: 4, timezone: "Asia/Hong_Kong", now });
    // "tomorrow" on the user's calendar is Nov 11 00:00 HKT == Nov 10 16:00 UTC
    expect(formatDateForDB(result.nextReviewDate)).toBe("2026-11-10 16:00:00");
  });

  test("'again' lapses back to one day at the user's local midnight", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const result = sm2Algorithm({
      easeFactor: 2.5,
      interval: 10,
      repetitions: 3,
      rating: 0,
      timezone: "Asia/Hong_Kong",
      now,
    });
    expect(result.interval).toBe(1);
    expect(formatDateForDB(result.nextReviewDate)).toBe("2026-11-09 16:00:00");
  });

  test("without a timezone, the legacy server-local boundary is preserved", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const result = sm2Algorithm({ ...base, rating: 4, now });
    const legacy = new Date(now);
    legacy.setDate(legacy.getDate() + 1);
    legacy.setHours(0, 0, 0, 0);
    expect(formatDateForDB(result.nextReviewDate)).toBe(formatDateForDB(legacy));
  });
});
