import { describe, expect, test } from "bun:test";
import { isSameLocalDay, isSessionStateStale } from "../../lib/review-session-state.ts";

describe("isSameLocalDay", () => {
  test("same instant is the same day", () => {
    const t = new Date(2026, 10, 10, 9, 30, 0);
    expect(isSameLocalDay(t, t)).toBe(true);
  });

  test("same day, different times", () => {
    expect(
      isSameLocalDay(new Date(2026, 10, 10, 0, 0, 1), new Date(2026, 10, 10, 23, 59, 59))
    ).toBe(true);
  });

  test("different day / year boundary", () => {
    expect(
      isSameLocalDay(new Date(2026, 10, 9, 23, 59, 0), new Date(2026, 10, 10, 0, 1, 0))
    ).toBe(false);
    expect(isSameLocalDay(new Date(2026, 11, 31, 12, 0, 0), new Date(2027, 0, 1, 12, 0, 0))).toBe(
      false
    );
  });
});

describe("isSessionStateStale", () => {
  test("state updated earlier today is fresh", () => {
    const now = new Date(2026, 10, 10, 15, 0, 0);
    expect(
      isSessionStateStale({ updatedAt: new Date(2026, 10, 10, 2, 2, 0).toISOString() }, now)
    ).toBe(false);
  });

  test("state updated yesterday is stale", () => {
    const now = new Date(2026, 10, 10, 0, 0, 30);
    expect(
      isSessionStateStale({ updatedAt: new Date(2026, 10, 9, 23, 58, 0).toISOString() }, now)
    ).toBe(true);
  });

  test("state from the far past is stale", () => {
    const now = new Date(2026, 10, 10, 12, 0, 0);
    expect(
      isSessionStateStale({ updatedAt: new Date(2025, 0, 1, 12, 0, 0).toISOString() }, now)
    ).toBe(true);
  });

  test("future updatedAt (device clock ran ahead) is kept, not dropped", () => {
    const now = new Date(2026, 10, 10, 12, 0, 0);
    expect(
      isSessionStateStale({ updatedAt: new Date(2026, 10, 11, 12, 0, 0).toISOString() }, now)
    ).toBe(false);
  });

  test("unparseable updatedAt is stale", () => {
    expect(
      isSessionStateStale({ updatedAt: "not a date" }, new Date(2026, 10, 10, 12, 0, 0))
    ).toBe(true);
  });
});
