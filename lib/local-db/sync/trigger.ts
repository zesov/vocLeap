import { getLocalDb } from "../client";
import { runSyncOnce } from "./engine";

let timer: ReturnType<typeof setTimeout> | null = null;

/** Debounced "push my changes now" signal used by the data facade. */
export function requestSync(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const db = getLocalDb();
    if (!db) return;
    void runSyncOnce(db).catch(() => {
      // 401 is handled by the auth layer; other failures surface via status.
    });
  }, 250);
}
