import { getLocalDb } from "../client";
import { pushPendingOps, runSyncOnce } from "./engine";

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * "My changes need to reach the server" signal used by the data facade.
 * Fires an immediate push — a rating written to the local DB must survive
 * an instant reload/close, and a page-exit flush can land too late because
 * reading the oplog through the worker during teardown is slow — then keeps
 * the debounced full sync as the batching catch-all.
 */
export function requestSync(): void {
  const db = getLocalDb();
  if (db) {
    void pushPendingOps(db).catch(() => {
      // Offline or 401: the debounced sync retries with full status.
    });
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const db = getLocalDb();
    if (!db) return;
    void runSyncOnce(db).catch(() => {
      // 401 is handled by the auth layer; other failures surface via status.
    });
  }, 250);
}

/**
 * Last-chance keepalive push for ops still pending when the page is reloaded
 * or closed. The endpoint is idempotent, so ops that were already pushed are
 * harmlessly re-applied, and anything this request misses is retried by the
 * next boot's sync.
 */
export function flushPendingOpsOnPageExit(): void {
  void (async () => {
    const db = getLocalDb();
    if (!db) return;
    await pushPendingOps(db, { keepalive: true });
  })().catch(() => {
    // Offline or the worker is already gone: the ops stay in the local
    // oplog and the next boot's sync retries them.
  });
}
