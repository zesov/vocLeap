import { describe, expect, test } from "bun:test";
import { addCalendarDaysInZone, resolveClientTimezone } from "./timezone";

describe("addCalendarDaysInZone", () => {
  test("Asia/Hong_Kong: next day's local midnight lands at 16:00 UTC the day before", () => {
    // 2026-11-09 12:00 UTC == 2026-11-09 20:00 HKT
    const now = new Date("2026-11-09T12:00:00.000Z");
    const due = addCalendarDaysInZone("Asia/Hong_Kong", now, 1);
    // 2026-11-10 00:00 HKT == 2026-11-09 16:00 UTC
    expect(due.toISOString()).toBe("2026-11-09T16:00:00.000Z");
  });

  test("UTC: local midnight is exactly midnight UTC", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    expect(addCalendarDaysInZone("UTC", now, 1).toISOString()).toBe(
      "2026-11-10T00:00:00.000Z"
    );
  });

  test("America/New_York: boundaries stay at local midnight across the DST end", () => {
    // 2026-10-31 20:00 UTC == 16:00 EDT (UTC-4)
    const now = new Date("2026-10-31T20:00:00.000Z");
    // 2026-11-01 00:00 EDT == 04:00 UTC (DST still active at that midnight)
    expect(addCalendarDaysInZone("America/New_York", now, 1).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z"
    );
    // 2026-11-02 00:00 EST == 05:00 UTC (DST ended 02:00 local on Nov 1)
    expect(addCalendarDaysInZone("America/New_York", now, 2).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z"
    );
  });

  test("rolls over month and year boundaries", () => {
    const now = new Date("2026-12-31T12:00:00.000Z");
    expect(addCalendarDaysInZone("UTC", now, 1).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });
});

describe("resolveClientTimezone", () => {
  test("accepts supported IANA zone names", () => {
    expect(resolveClientTimezone("Asia/Hong_Kong")).toBe("Asia/Hong_Kong");
    expect(resolveClientTimezone("UTC")).toBe("UTC");
  });

  test("rejects invalid or missing values", () => {
    expect(resolveClientTimezone("Not/AZone")).toBeNull();
    expect(resolveClientTimezone("")).toBeNull();
    expect(resolveClientTimezone("   ")).toBeNull();
    expect(resolveClientTimezone(42)).toBeNull();
    expect(resolveClientTimezone(null)).toBeNull();
    expect(resolveClientTimezone(undefined)).toBeNull();
  });
});
