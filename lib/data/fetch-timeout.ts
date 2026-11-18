/**
 * Network watchdog for every client-side fetch. A hanging request on a bad
 * (slow, not fully offline) network must fail fast so callers can fall back
 * to local data instead of freezing the UI on the browser's default
 * multi-minute socket timeout.
 */

export const NETWORK_TIMEOUT_MESSAGE = "Network request timed out";

/** Requests considered "hung" are aborted after this long. */
export type TimeoutMs = number;

export function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === NETWORK_TIMEOUT_MESSAGE || error.name === "TimeoutError")
  );
}

function timeoutError(): Error {
  const error = new Error(NETWORK_TIMEOUT_MESSAGE);
  error.name = "TimeoutError";
  return error;
}

/**
 * Fetch wrapper that aborts the request after `timeoutMs` and converts the
 * abort into an Error carrying `NETWORK_TIMEOUT_MESSAGE` (with
 * `name: "TimeoutError"`) so callers can distinguish timeouts from other
 * network failures. `AbortSignal.timeout` fires a `TimeoutError` DOMException,
 * which real fetches surface as the rejection reason.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: TimeoutMs,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (isTimeoutError(error)) throw timeoutError();
    throw error;
  }
}

/**
 * Wraps a fetch implementation so every call gets the deadline. Used by the
 * sync engine: tests inject their own (immediately-resolving) fetchImpl and
 * are unaffected, while the default network path gains the watchdog.
 */
export function withFetchTimeout(
  fetchImpl: typeof fetch,
  timeoutMs: TimeoutMs
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithTimeout(String(input), init, timeoutMs, fetchImpl);
}
