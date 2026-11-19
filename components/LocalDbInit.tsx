"use client";

import { useEffect, useState } from "react";
import { remoteData } from "@/lib/data/remote";
import { withDeadlineStatus } from "@/lib/deadline";
import { getLocalDb, initLocalDb, getLocalDbState, subscribeLocalDb } from "@/lib/local-db/client";
import { backfillBareWords } from "@/lib/local-db/backfill";
import { runSyncOnce, startSyncScheduler } from "@/lib/local-db/sync/engine";
import { flushPendingOpsOnPageExit } from "@/lib/local-db/sync/trigger";

interface LocalDbInitProps {
  userId: number;
  email: string;
  srsAlgorithm: "sm2" | "fsrs";
  children: React.ReactNode;
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
 * the background sync loop. Shows a loading banner while initializing.
 */
export default function LocalDbInit({
  userId,
  email,
  srsAlgorithm,
  children,
}: LocalDbInitProps) {
  const [localState, setLocalState] = useState(getLocalDbState());
  const [bootstrapTimedOut, setBootstrapTimedOut] = useState(false);

  useEffect(() => subscribeLocalDb(setLocalState), []);

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
      bootstrap: async (db) => {
        const result = await withDeadlineStatus(runSyncOnce(db), BOOTSTRAP_DEADLINE_MS);
        if (result.timedOut && !cancelled) {
          setBootstrapTimedOut(true);
        }
        return result.value;
      },
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

  // Show loading banner during init/busy, or bootstrap timeout warning
  if (localState.status === "init" || localState.status === "busy") {
    return (
      <>
        <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-center text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
          Initializing offline database…
        </div>
        {children}
      </>
    );
  }

  if (bootstrapTimedOut) {
    return (
      <>
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Loading server data… (slow network)
        </div>
        {children}
      </>
    );
  }

  return <>{children}</>;
}
