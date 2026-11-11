"use client";

import { useEffect } from "react";
import { getLocalDb, initLocalDb } from "@/lib/local-db/client";
import { runSyncOnce, startSyncScheduler } from "@/lib/local-db/sync/engine";
import { flushPendingOpsOnPageExit } from "@/lib/local-db/sync/trigger";

interface LocalDbInitProps {
  userId: number;
  email: string;
  srsAlgorithm: "sm2" | "fsrs";
}

/**
 * Boots the per-user browser database once per signed-in session and starts
 * the background sync loop. Renders nothing.
 */
export default function LocalDbInit({
  userId,
  email,
  srsAlgorithm,
}: LocalDbInitProps) {
  useEffect(() => {
    let cancelled = false;
    let stopSync: (() => void) | null = null;

    const onHidden = () => {
      if (document.visibilityState === "hidden") flushPendingOpsOnPageExit();
    };

    void initLocalDb({
      userId,
      email,
      srsAlgorithm,
      // First run on this device: pull the server state before components read
      // the file. runSyncOnce reports failures as sync status, so this only
      // delays readiness by one round trip.
      bootstrap: (db) => runSyncOnce(db),
    }).then((state) => {
      if (cancelled || state.status !== "ready") return;
      stopSync = startSyncScheduler({ db: () => getLocalDb() });
      // The debounced push dies with the page; flush pending ops (ratings
      // written seconds before a reload/close) with a keepalive request so
      // the next visit does not resurrect already-reviewed words.
      window.addEventListener("pagehide", flushPendingOpsOnPageExit);
      document.addEventListener("visibilitychange", onHidden);
    });

    return () => {
      cancelled = true;
      stopSync?.();
      window.removeEventListener("pagehide", flushPendingOpsOnPageExit);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [userId, email, srsAlgorithm]);

  return null;
}
