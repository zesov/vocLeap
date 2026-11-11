import { describe, expect, test } from "bun:test";
import { ZERO_CURSOR, decodeCursor, encodeCursor } from "../../../lib/sync/cursor";

describe("sync cursor", () => {
  test("round-trips through the URL-safe encoding", () => {
    const cursor = {
      wTs: "2026-11-10T10:00:00.000Z",
      wId: 12,
      rTs: "2026-11-10T09:00:00.000Z",
      rId: 3,
      hId: 99,
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  test("the encoding is URL-safe", () => {
    expect(encodeCursor(ZERO_CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("falls back to the zero cursor for missing or invalid input", () => {
    expect(decodeCursor(null)).toEqual(ZERO_CURSOR);
    expect(decodeCursor("not-base64-json")).toEqual(ZERO_CURSOR);
    expect(decodeCursor(encodeCursor({ ...ZERO_CURSOR, wId: -1 }))).toEqual(
      ZERO_CURSOR
    );
    expect(decodeCursor(encodeCursor({ ...ZERO_CURSOR, hId: 1.5 }))).toEqual(
      ZERO_CURSOR
    );
  });
});
