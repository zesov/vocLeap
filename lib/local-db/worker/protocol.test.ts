import { describe, expect, test } from "bun:test";
import { isWorkerRequest } from "./protocol";

describe("isWorkerRequest", () => {
  test("accepts a valid init request", () => {
    expect(
      isWorkerRequest({
        type: "init",
        id: 1,
        request: { engine: "auto", userId: 3, fileName: "vocleap-user-3.sqlite3" },
      })
    ).toBe(true);
  });

  test("accepts all/run/exec/batch requests", () => {
    expect(isWorkerRequest({ type: "all", id: 2, sql: "SELECT 1", params: [] })).toBe(true);
    expect(isWorkerRequest({ type: "run", id: 3, sql: "DELETE FROM words" })).toBe(true);
    expect(isWorkerRequest({ type: "exec", id: 5, sql: "PRAGMA user_version" })).toBe(true);
    expect(
      isWorkerRequest({
        type: "batch",
        id: 4,
        statements: [{ sql: "SELECT 1", params: [] }],
      })
    ).toBe(true);
  });

  test("rejects malformed input", () => {
    expect(isWorkerRequest(null)).toBe(false);
    expect(isWorkerRequest({})).toBe(false);
    expect(isWorkerRequest({ type: "init", id: 1 })).toBe(false);
    expect(isWorkerRequest({ type: "all", id: 1 })).toBe(false);
    expect(isWorkerRequest({ type: "batch", id: 1, statements: [{}] })).toBe(false);
    expect(isWorkerRequest({ type: "nope", id: 1 })).toBe(false);
  });

  test("rejects non-integer ids", () => {
    expect(isWorkerRequest({ type: "all", id: "1", sql: "SELECT 1" })).toBe(false);
  });
});
