"use client";

import { useEffect, useState } from "react";
import { getLocalDbState, subscribeLocalDb } from "@/lib/local-db/client";
import {
  getSyncStatus,
  resetSyncPause,
  subscribeSync,
} from "@/lib/local-db/sync/engine";
import { requestSync } from "@/lib/local-db/sync/trigger";

export default function SyncStatus() {
  const [local, setLocal] = useState(getLocalDbState);
  const [sync, setSync] = useState(getSyncStatus);
  const [online, setOnline] = useState(true);

  useEffect(() => subscribeLocalDb(setLocal), []);
  useEffect(() => subscribeSync(setSync), []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (local.status === "idle" || local.status === "init") return null;

  if (local.status === "busy") {
    return (
      <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        Offline mode is unavailable because Vocleap is open in another tab.
      </p>
    );
  }

  if (local.status === "failed") {
    return (
      <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        Offline mode is unavailable{local.error ? `: ${local.error}` : ""}.
        Changes are saved to the server.
      </p>
    );
  }

  if (!online) {
    return (
      <p className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-center text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
        Offline — your changes are stored on this device and will sync when the
        connection returns.
      </p>
    );
  }

  if (sync.phase === "paused") {
    return (
      <p className="flex items-center justify-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        Sync paused{sync.error ? `: ${sync.error}` : ""}.
        <button
          type="button"
          className="rounded-md border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/40"
          onClick={() => {
            resetSyncPause();
            requestSync();
          }}
        >
          Retry
        </button>
      </p>
    );
  }

  if (sync.pending > 0) {
    return (
      <p className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-center text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300">
        {sync.pending} change{sync.pending === 1 ? "" : "s"} waiting to sync…
      </p>
    );
  }

  return null;
}
