"use client";

import { useEffect } from "react";
import { getLocalDb, initLocalDb } from "@/lib/local-db/client";
import { runSyncOnce, startSyncScheduler } from "@/lib/local-db/sync/engine";

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
    });

    return () => {
      cancelled = true;
      stopSync?.();
    };
  }, [userId, email, srsAlgorithm]);

  return null;
}
