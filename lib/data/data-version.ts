"use client";

import { useSyncExternalStore } from "react";

/**
 * Monotonic counter bumped whenever a background sync pull merges data that
 * differs from the local file. Pages that are showing NOTHING (offline cold
 * start on a fresh device: the local DB published empty, the first pull lands
 * later) subscribe to it and re-fetch. Pages with content on screen ignore it,
 * so a late merge can never clobber an active list or session.
 */

let version = 0;
const listeners = new Set<() => void>();

export function getDataVersion(): number {
  return version;
}

export function bumpDataVersion(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders whenever a sync pull merged changes. */
export function useSyncDataVersion(): number {
  return useSyncExternalStore(subscribe, getDataVersion, getDataVersion);
}
