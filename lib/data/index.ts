import { getLocalDb } from "../local-db/client";
import { requestSync } from "../local-db/sync/trigger";
import type { DataApi } from "./api";
import { createLocalData } from "./local";
import { remoteData } from "./remote";

let cachedHandle: unknown = null;
let cachedData: DataApi | null = null;

/**
 * The data facade. Returns the local implementation as soon as the local
 * database is ready, otherwise the HTTP implementation. Response shapes are
 * identical, so components never branch on the mode.
 */
export function getData(): DataApi {
  const handle = getLocalDb();
  if (!handle) return remoteData;

  if (handle !== cachedHandle) {
    cachedHandle = handle;
    cachedData = createLocalData(handle, remoteData, requestSync);
  }
  return cachedData ?? remoteData;
}

export type { DataApi } from "./api";
export { ApiError } from "./remote";
export { remoteData } from "./remote";
