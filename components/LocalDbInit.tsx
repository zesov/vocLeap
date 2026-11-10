"use client";

import { useEffect } from "react";
import { getLocalDb, initLocalDb } from "@/lib/local-db/client";
import { startSyncScheduler } from "@/lib/local-db/sync/engine";

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

    void initLocalDb({ userId, email, srsAlgorithm }).then((state) => {
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
