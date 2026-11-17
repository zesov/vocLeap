"use client";

import { useEffect } from "react";
import { remoteData } from "@/lib/data/remote";
import { withDeadline } from "@/lib/deadline";
import { getLocalDb, initLocalDb } from "@/lib/local-db/client";
import { backfillBareWords } from "@/lib/local-db/backfill";
import { runSyncOnce, startSyncScheduler } from "@/lib/local-db/sync/engine";
import { flushPendingOpsOnPageExit } from "@/lib/local-db/sync/trigger";

interface LocalDbInitProps {
  userId: number;
  email: string;
  srsAlgorithm: "sm2" | "fsrs";
}

/**
 * The bootstrap pull must never hold the app hostage on a bad network: after
 * this deadline the local DB publishes anyway (possibly empty) and the sync
 * keeps running in the background. Pages showing nothing re-fetch when the
 * late pull merges data (see lib/data/data-version.ts).
 */
const BOOTSTRAP_DEADLINE_MS = 2500;

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
      // Best-effort first pull before components read the file, capped so a
      // hanging request cannot delay readiness beyond the deadline.
      bootstrap: (db) => withDeadline(runSyncOnce(db), BOOTSTRAP_DEADLINE_MS),
    }).then((state) => {
      if (cancelled || state.status !== "ready") return;
      stopSync = startSyncScheduler({
        db: () => getLocalDb(),
        // Enrich offline-saved bare words after each fully successful cycle.
        onIdle: (db) => {
          void backfillBareWords(db, remoteData);
        },
      });
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
