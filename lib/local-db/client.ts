import type { SqlExecutor, SqlStep } from "./executor";
import { migrateLocalSchema, setMetaIfAbsent } from "./schema";
import type {
  LocalDbMode,
  WorkerCallMessage,
  WorkerEvent,
  WorkerRequest,
} from "./worker/protocol";

export interface LocalDbState {
  status: "idle" | "init" | "ready" | "busy" | "failed";
  mode: LocalDbMode;
  engine: string | null;
  error: string | null;
}

export function initialLocalDbState(): LocalDbState {
  return { status: "idle", mode: "online", engine: null, error: null };
}

export function reduceLocalDbState(
  _previous: LocalDbState,
  event: WorkerEvent
): LocalDbState {
  switch (event.type) {
    case "ready":
      return { status: "ready", mode: event.mode, engine: event.engine, error: null };
    case "db-busy":
      return { status: "busy", mode: "online", engine: null, error: null };
    case "init-error":
      return { status: "failed", mode: "online", engine: null, error: event.message };
    default:
      return _previous;
  }
}

export function isOfflineCapable(state: LocalDbState): boolean {
  return state.status === "ready" && state.mode !== "online";
}

export interface LocalDbHandle extends SqlExecutor {
  mode: Exclude<LocalDbMode, "online">;
  engine: string;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface InitOptions {
  userId: number;
  email?: string;
  srsAlgorithm?: string;
  engine?: "auto" | "opfs" | "idb";
}

const LOCK_PREFIX = "vocleap-db-";

let state: LocalDbState = initialLocalDbState();
let worker: Worker | null = null;
let handle: LocalDbHandle | null = null;
let pending = new Map<number, PendingCall>();
let nextId = 1;
const listeners = new Set<(state: LocalDbState) => void>();
let initPromise: Promise<LocalDbState> | null = null;
let initializedFor: number | null = null;
let releaseLock: (() => void) | null = null;

function emit() {
  for (const listener of listeners) listener(state);
}

function setState(next: LocalDbState) {
  state = next;
  emit();
}

export function getLocalDbState(): LocalDbState {
  return state;
}

export function getLocalDb(): LocalDbHandle | null {
  return handle;
}

export function subscribeLocalDb(listener: (state: LocalDbState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

async function acquireLock(name: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return true;
  return new Promise<boolean>((resolve) => {
    void navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise<void>((release) => {
          releaseLock = release;
        });
      })
      .catch(() => resolve(false));
  });
}

function call<T>(message: WorkerCallMessage): Promise<T> {
  const active = worker;
  if (!active) return Promise.reject(new Error("Worker is not running"));
  const id = nextId;
  nextId += 1;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    active.postMessage({ ...message, id });
  });
}

function makeRemoteExecutor(): SqlExecutor {
  return {
    all: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      call<T[]>({ type: "all", sql, params }),
    run: (sql, params) => call<{ changes: number }>({ type: "run", sql, params }),
    exec: (sql) => call<void>({ type: "exec", sql }),
    batch: (statements: SqlStep[]) => call<void>({ type: "batch", statements }),
  };
}

function attach(active: Worker) {
  active.addEventListener("message", (event: MessageEvent<WorkerEvent>) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "ready") {
      pending.delete(message.id);
      handle = Object.assign(makeRemoteExecutor(), {
        mode: message.mode,
        engine: message.engine,
      });
      setState(reduceLocalDbState(state, message));
      return;
    }

    if (message.type === "db-busy" || message.type === "init-error") {
      pending.delete(message.id);
      handle = null;
      setState(reduceLocalDbState(state, message));
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === "result") entry.resolve(message.result);
    else entry.reject(new Error(message.message));
  });

  active.addEventListener("error", (event) => {
    setState({
      status: "failed",
      mode: "online",
      engine: null,
      error: event.message || "Worker crashed",
    });
    for (const entry of pending.values()) {
      entry.reject(new Error("Worker crashed"));
    }
    pending = new Map();
  });
}

export async function initLocalDb(options: InitOptions): Promise<LocalDbState> {
  if (initializedFor === options.userId && state.status !== "idle") {
    return state;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    setState({ ...state, status: "init", error: null });

    const locked = await acquireLock(`${LOCK_PREFIX}${options.userId}`);
    if (!locked) {
      setState({ status: "busy", mode: "online", engine: null, error: null });
      return state;
    }

    worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
      type: "module",
    });
    attach(worker);

    const initId = nextId;
    nextId += 1;
    const ready = new Promise<WorkerEvent>((resolve) => {
      const listener = (event: MessageEvent<WorkerEvent>) => {
        const message = event.data;
        if (
          message?.id === initId &&
          (message.type === "ready" ||
            message.type === "db-busy" ||
            message.type === "init-error")
        ) {
          worker?.removeEventListener("message", listener);
          resolve(message);
        }
      };
      worker?.addEventListener("message", listener);
    });

    worker.postMessage({
      type: "init",
      id: initId,
      request: {
        engine: options.engine ?? "auto",
        userId: options.userId,
        fileName: `vocleap-user-${options.userId}.sqlite3`,
      },
    } satisfies WorkerRequest);

    const event = await ready;
    if (event.type !== "ready") {
      return state;
    }

    const db = handle;
    if (!db) return state;

    try {
      await migrateLocalSchema(db);
      await setMetaIfAbsent(db, "user_id", String(options.userId));
      if (options.email) {
        await setMetaIfAbsent(db, "email", options.email);
      }
      if (options.srsAlgorithm) {
        await setMetaIfAbsent(db, "srs_algorithm", options.srsAlgorithm);
      }
      initializedFor = options.userId;
    } catch (error) {
      setState({
        status: "failed",
        mode: "online",
        engine: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return state;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

export async function closeLocalDb(): Promise<void> {
  if (worker) {
    try {
      await call({ type: "close" });
    } catch {
      // ignore: the worker may already be gone
    }
    worker.terminate();
    worker = null;
  }
  handle = null;
  pending = new Map();
  initializedFor = null;
  releaseLock?.();
  releaseLock = null;
  setState(initialLocalDbState());
}
