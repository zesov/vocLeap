import { describe, expect, test } from "bun:test";
import {
  initialLocalDbState,
  isOfflineCapable,
  reduceLocalDbState,
} from "./client";

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
