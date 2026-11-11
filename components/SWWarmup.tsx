"use client";

import { useEffect } from "react";
import { useSerwist } from "@serwist/turbopack/react";

// Installs the Turbopack worker URL-fragment shim before any effect can
// construct the local-db worker.
import "@/lib/pwa/turbopack-worker-shim";

// The first navigation of a session completes before the service worker
// takes control, so that page's HTML is never runtime-cached — an offline
// reload of it would hit the /~offline fallback. Warming the current URL
// through Serwist's CACHE_URLS message closes that gap.
export function SWWarmup() {
  const { serwist } = useSerwist();

  useEffect(() => {
    if (!serwist) return;
    serwist.messageSW({
      type: "CACHE_URLS",
      payload: { urlsToCache: [window.location.href] },
    });
  }, [serwist]);

  return null;
}
