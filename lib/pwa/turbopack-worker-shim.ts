"use client";

// Turbopack passes `new Worker` bootstrap config through the script URL's
// fragment (`worker.js#params=<encoded json>`) because URL fragments are not
// sent to the server. Fragments are also stripped by the Cache API, so once
// the service worker serves the worker chunk from a cache, the worker's
// `location.href` has no `#params=` and its runtime throws
// "Missing worker bootstrap config". Moving the config into a `?params=`
// query string (the format Turbopack itself uses for SharedWorker) makes it
// survive caching. The shim must run before the first worker is constructed
// (the local-db worker is created lazily from an effect), hence the
// module-scope side effect.

declare global {
  interface Window {
    __turbopackWorkerShimApplied?: boolean;
  }
}

if (typeof window !== "undefined" && !window.__turbopackWorkerShimApplied) {
  window.__turbopackWorkerShimApplied = true;

  const nativeWorker = window.Worker;

  class WorkerWithSearchParams extends nativeWorker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      try {
        const url = new URL(scriptURL, window.location.href);
        if (
          url.hash.startsWith("#params=") &&
          !url.searchParams.has("params")
        ) {
          // `url.hash` is percent-encoded; URLSearchParams re-encodes on
          // serialization, so decode first to avoid double encoding.
          url.searchParams.set(
            "params",
            decodeURIComponent(url.hash.slice("#params=".length)),
          );
          url.hash = "";
          super(url, options);
          return;
        }
      } catch {
        // Invalid URL or no fragment config: fall through to the native
        // constructor so it surfaces the original error.
      }
      super(scriptURL, options);
    }
  }

  window.Worker = WorkerWithSearchParams;
}

export {};
