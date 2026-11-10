import { encodeCursor, ZERO_CURSOR, type SyncCursor } from "../../sync/cursor";
import type { PullPage } from "../../sync/server-pull";
import type { SyncPushResponse } from "../../sync/types";
import type { SqlExecutor } from "../executor";
import { getMeta, setMeta } from "../schema";
import { mergePullPage } from "./merge";
import { ackOps, getPendingOps, pendingCount } from "./oplog";

export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthRequiredError";
  }
}

export type SyncPhase = "idle" | "syncing" | "offline" | "paused" | "error";

export interface SyncStatus {
  phase: SyncPhase;
  pending: number;
  lastSyncedAt: string | null;
  error: string | null;
}

const MAX_PUSH_BATCHES = 10;
const MAX_PULL_PAGES = 20;

let paused = false;
let running = false;
let status: SyncStatus = {
  phase: "idle",
  pending: 0,
  lastSyncedAt: null,
  error: null,
};
const listeners = new Set<(status: SyncStatus) => void>();

function emit(next: Partial<SyncStatus>): SyncStatus {
  status = { ...status, ...next };
  for (const listener of listeners) listener(status);
  return status;
}

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSync(listener: (status: SyncStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => {
    listeners.delete(listener);
  };
}

export function isSyncPaused(): boolean {
  return paused;
}

export function resetSyncPause(): void {
  paused = false;
  if (status.phase === "paused") emit({ phase: "idle", error: null });
}

function sameCursor(a: SyncCursor, b: SyncCursor): boolean {
  return (
    a.wTs === b.wTs &&
    a.wId === b.wId &&
    a.rTs === b.rTs &&
    a.rId === b.rId &&
    a.hId === b.hId
  );
}

async function readCursor(db: SqlExecutor): Promise<SyncCursor> {
  const raw = await getMeta(db, "sync_cursor");
  if (!raw) return ZERO_CURSOR;
  try {
    return JSON.parse(raw) as SyncCursor;
  } catch {
    return ZERO_CURSOR;
  }
}

export interface RunSyncOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * One full push-then-pull cycle. Throws `AuthRequiredError` on 401 so the
 * caller can route the user to sign-in; every other failure surfaces as a
 * status phase so the UI can retry.
 */
export async function runSyncOnce(
  db: SqlExecutor,
  options: RunSyncOptions = {}
): Promise<SyncStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.now ?? (() => new Date());

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return emit({ phase: "offline", pending: await pendingCount(db) });
  }
  if (paused) {
    return emit({ phase: "paused", pending: await pendingCount(db) });
  }
  if (running) return status;

  running = true;
  emit({ phase: "syncing", error: null });

  try {
    for (let batch = 0; batch < MAX_PUSH_BATCHES; batch += 1) {
      const ops = await getPendingOps(db, 200);
      if (ops.length === 0) break;

      const response = await fetchImpl("/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ops }),
      });

      if (response.status === 401) throw new AuthRequiredError();
      if (!response.ok) {
        throw new Error(`Push failed with ${response.status}`);
      }

      const body = (await response.json()) as SyncPushResponse;
      const settled: string[] = [];
      let rejection: string | null = null;
      for (const result of body.results) {
        if (result.accepted) settled.push(result.opId);
        else rejection = result.reason ?? "rejected";
      }
      if (settled.length > 0) await ackOps(db, settled);

      if (rejection) {
        paused = true;
        return emit({
          phase: "paused",
          pending: await pendingCount(db),
          error: rejection,
        });
      }
      if (body.results.length === 0) break;
    }

    let cursor = await readCursor(db);
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const response = await fetchImpl(
        `/api/sync/pull?cursor=${encodeURIComponent(encodeCursor(cursor))}`,
        { credentials: "same-origin" }
      );
      if (response.status === 401) throw new AuthRequiredError();
      if (!response.ok) {
        throw new Error(`Pull failed with ${response.status}`);
      }

      const body = (await response.json()) as PullPage;
      await mergePullPage(db, body);
      const next = body.nextCursor;
      const settledCursor = sameCursor(next, cursor);
      cursor = next;
      await setMeta(db, "sync_cursor", JSON.stringify(cursor));
      if (settledCursor) break;
    }

    const lastSyncedAt = clock().toISOString();
    await setMeta(db, "last_synced_at", lastSyncedAt);
    return emit({
      phase: "idle",
      pending: await pendingCount(db),
      lastSyncedAt,
      error: null,
    });
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      emit({
        phase: "error",
        pending: await pendingCount(db),
        error: "Authentication required",
      });
      throw error;
    }
    return emit({
      phase: "error",
      pending: await pendingCount(db),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running = false;
  }
}

export interface SchedulerOptions {
  db: () => SqlExecutor | null;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Runs a sync immediately, on an interval, when the tab becomes visible and
 * when connectivity returns. Returns a stop function.
 */
export function startSyncScheduler(options: SchedulerOptions): () => void {
  const intervalMs = options.intervalMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const db = options.db();
      if (!db) return;
      void runSyncOnce(db, { fetchImpl: options.fetchImpl }).catch(() => {
        // 401 is handled by the auth layer; other errors surface via status
      });
    }, 250);
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };

  run();
  const interval = setInterval(run, intervalMs);
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(interval);
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
