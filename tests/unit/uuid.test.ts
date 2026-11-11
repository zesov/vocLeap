import { describe, expect, test } from "bun:test";
import { uuidv7 } from "../../lib/uuid";

describe("uuidv7", () => {
  test("produces a well-formed v7 UUID", () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test("is time-ordered", () => {
    const first = uuidv7();
    const second = uuidv7();
    expect(first < second).toBe(true);
  });

  test("does not repeat", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => uuidv7()));
    expect(ids.size).toBe(2000);
  });
});
