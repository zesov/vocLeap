import { describe, expect, test } from "bun:test";
import {
  NETWORK_TIMEOUT_MESSAGE,
  isTimeoutError,
  withFetchTimeout,
} from "../../../lib/data/fetch-timeout";
import { withDeadline } from "../../../lib/deadline";

function hang(): typeof fetch {
  // A fake that honours the abort signal the way a real fetch does.
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject((init.signal as AbortSignal).reason)
      );
    })) as typeof fetch;
}

describe("fetchWithTimeout", () => {
  test("resolves when the response arrives in time", async () => {
    const fast = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    const response = await withFetchTimeout(fast, 1000)("/api/words");
    expect(response.status).toBe(200);
  });

  test("rejects with NETWORK_TIMEOUT_MESSAGE when the request hangs", async () => {
    const started = Date.now();
    let error: Error | null = null;
    try {
      // Directly exercise the abort path via a hanging fetchImpl.
      await withFetchTimeout(hang(), 30)("/api/sync/pull");
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).toBe(NETWORK_TIMEOUT_MESSAGE);
    expect(error?.name).toBe("TimeoutError");
    expect(isTimeoutError(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("isTimeoutError distinguishes timeouts from other failures", () => {
    const timeout = new Error(NETWORK_TIMEOUT_MESSAGE);
    timeout.name = "TimeoutError";
    expect(isTimeoutError(timeout)).toBe(true);
    expect(isTimeoutError(new Error("Push failed with 500"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});

describe("withDeadline", () => {
  test("returns the value when the promise settles in time", async () => {
    expect(await withDeadline(Promise.resolve("ok"), 1000)).toBe("ok");
  });

  test("returns null at the deadline and lets the promise keep running", async () => {
    let settled = false;
    const slow = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      settled = true;
      return "late";
    })();

    const started = Date.now();
    expect(await withDeadline(slow, 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(150);

    // The underlying work still completes.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(true);
  });

  test("swallows rejection after the deadline was already taken", async () => {
    const failing = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("late failure")), 80);
    });
    expect(await withDeadline(failing, 10)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
});
