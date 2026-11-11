"use client";

import { useSyncExternalStore } from "react";
import { getLocalDbState, subscribeLocalDb } from "../local-db/client";
import type { DataApi } from "./api";
import { getData } from "./index";

/**
 * Re-renders when the local database becomes ready (or falls back to online),
 * and returns the currently appropriate data implementation.
 */
export function useData(): DataApi {
  useSyncExternalStore(subscribeLocalDb, getLocalDbState, getLocalDbState);
  return getData();
}
