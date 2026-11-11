import { describe, expect, test } from "bun:test";
import {
  initialLocalDbState,
  isFatalStorageError,
  isOfflineCapable,
  reduceLocalDbState,
} from "../../../lib/local-db/client";

describe("local db state reducer", () => {
  test("starts idle and online", () => {
    expect(initialLocalDbState()).toEqual({
      status: "idle",
      mode: "online",
      engine: null,
      error: null,
    });
  });

  test("ready event exposes the engine mode", () => {
    const state = reduceLocalDbState(initialLocalDbState(), {
      type: "ready",
      id: 1,
      mode: "opfs",
      engine: "sqlite-wasm/opfs-sahpool",
    });
    expect(state).toEqual({
      status: "ready",
      mode: "opfs",
      engine: "sqlite-wasm/opfs-sahpool",
      error: null,
    });
    expect(isOfflineCapable(state)).toBe(true);
  });

  test("db-busy falls back to online without an error banner", () => {
    const state = reduceLocalDbState(initialLocalDbState(), {
      type: "db-busy",
      id: 1,
      message: "open elsewhere",
    });
    expect(state.status).toBe("busy");
    expect(state.mode).toBe("online");
    expect(state.error).toBeNull();
    expect(isOfflineCapable(state)).toBe(false);
  });

  test("init-error records the message and falls back online", () => {
    const state = reduceLocalDbState(initialLocalDbState(), {
      type: "init-error",
      id: 1,
      message: "no wasm",
    });
    expect(state.status).toBe("failed");
    expect(state.mode).toBe("online");
    expect(state.error).toBe("no wasm");
    expect(isOfflineCapable(state)).toBe(false);
  });

  test("idb readiness is still offline capable", () => {
    const state = reduceLocalDbState(initialLocalDbState(), {
      type: "ready",
      id: 1,
      mode: "idb",
      engine: "wa-sqlite/indexeddb",
    });
    expect(isOfflineCapable(state)).toBe(true);
  });
});

describe("fatal storage errors", () => {
  // These mean the local file can no longer be trusted: keep using it and
  // every read fails, so the client must fall back to the server API.
  const fatal = [
    "disk I/O error",
    "database disk image is malformed",
    "database or disk is full",
    "SQLITE_IOERR_WRITE",
    "SQLITE_FULL",
    "QuotaExceededError: The quota has been exceeded.",
  ];
  for (const message of fatal) {
    test(`abandons the local db on: ${message}`, () => {
      expect(isFatalStorageError(message)).toBe(true);
    });
  }

  // Ordinary SQL/logic errors do not justify throwing the database away.
  const recoverable = [
    "no such table: words",
    "Database is not initialized",
    "SQL logic error",
    "UNIQUE constraint failed: words.word",
    // Environment issues that surface as storage errors but aren't fatal:
    "idb: Web Locks API unavailable (private browsing or non-secure origin)",
    "Cannot read properties of undefined (reading 'request')",
    "navigator.locks is undefined",
  ];
  for (const message of recoverable) {
    test(`keeps the local db on: ${message}`, () => {
      expect(isFatalStorageError(message)).toBe(false);
    });
  }
});
