/// <reference lib="webworker" />

import type { SqlExecutor } from "./executor";
import { DbBusyError, type WasmEngine } from "./worker/engine";
import { openSqliteWasmEngine } from "./worker/engine-sqlite-wasm";
import { openWaSqliteEngine } from "./worker/engine-wa-sqlite";
import {
  isWorkerRequest,
  type WorkerEvent,
  type WorkerRequest,
} from "./worker/protocol";

let engine: WasmEngine | null = null;
let executor: SqlExecutor | null = null;
let queue: Promise<void> = Promise.resolve();

const post = (event: WorkerEvent) => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(event);
};

function makeExecutor(target: WasmEngine): SqlExecutor {
  return {
    all: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      target.all<T>(sql, params),
    run: (sql, params) => target.run(sql, params),
    exec: (sql) => target.exec(sql),
    batch: (statements) => target.batch(statements),
  };
}

// Check if the environment supports Web Locks (required by wa-sqlite's IDBBatchAtomicVFS)
function hasWebLocksSupport(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "locks" in navigator &&
    typeof navigator.locks.request === "function"
  );
}

async function init(
  id: number,
  request: { engine: "auto" | "opfs" | "idb"; userId: number; fileName: string }
) {
  try {
    if (engine) await engine.close();
  } catch {
    // ignore a failed close; we are replacing the handle anyway
  }
  engine = null;
  executor = null;

  const order =
    request.engine === "opfs"
      ? (["opfs"] as const)
      : request.engine === "idb"
        ? (["idb"] as const)
        : (["opfs", "idb"] as const);

  const failures: string[] = [];
  let busy = false;

  for (const candidate of order) {
    // Skip wa-sqlite if Web Locks API is not available (it will fail with
    // "Cannot read properties of undefined (reading 'request')" otherwise).
    if (candidate === "idb" && !hasWebLocksSupport()) {
      failures.push("idb: Web Locks API unavailable (private browsing or non-secure origin)");
      continue;
    }
    try {
      const opened =
        candidate === "opfs"
          ? await openSqliteWasmEngine(request.fileName)
          : await openWaSqliteEngine(`vocleap-user-${request.userId}`);
      engine = opened;
      executor = makeExecutor(opened);
      post({
        type: "ready",
        id,
        mode: opened.mode,
        engine: opened.name,
      });
      return;
    } catch (error) {
      if (error instanceof DbBusyError) {
        busy = true;
        break;
      }
      // wa-sqlite's WebLocks failure surfaces as a cryptic TypeError.
      // Detect it and give a clear message instead of "disk I/O error".
      const msg = error instanceof Error ? error.message : String(error);
      if (
        candidate === "idb" &&
        /Cannot read properties of undefined.*request|navigator\.locks/.test(msg)
      ) {
        failures.push("idb: Web Locks API unavailable (private browsing or non-secure origin)");
        continue;
      }
      failures.push(`${candidate}: ${msg}`);
    }
  }

  if (busy) {
    post({ type: "db-busy", id, message: "Database is open in another tab" });
    return;
  }
  post({ type: "init-error", id, message: failures.join(" | ") });
}

async function handle(message: WorkerRequest) {
  if (message.type === "init") {
    await init(message.id, message.request);
    return;
  }
  if (message.type === "close") {
    try {
      if (engine) await engine.close();
    } finally {
      engine = null;
      executor = null;
    }
    post({ type: "result", id: message.id, result: null });
    return;
  }

  if (!executor) {
    post({ type: "error", id: message.id, message: "Database is not initialized" });
    return;
  }

  try {
    if (message.type === "all") {
      post({
        type: "result",
        id: message.id,
        result: await executor.all(message.sql, message.params),
      });
      return;
    }
    if (message.type === "run") {
      post({
        type: "result",
        id: message.id,
        result: await executor.run(message.sql, message.params),
      });
      return;
    }
    if (message.type === "exec") {
      await executor.exec(message.sql);
      post({ type: "result", id: message.id, result: null });
      return;
    }
    await executor.batch(message.statements);
    post({ type: "result", id: message.id, result: null });
  } catch (error) {
    post({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

self.addEventListener("message", (event: MessageEvent) => {
  const data: unknown = event.data;
  if (!isWorkerRequest(data)) {
    post({ type: "error", id: 0, message: "Malformed worker request" });
    return;
  }
  queue = queue.then(() => handle(data)).catch((error) => {
    post({
      type: "error",
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
