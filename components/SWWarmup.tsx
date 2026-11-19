"use client";

import { useEffect } from "react";
import { useSerwist } from "@serwist/turbopack/react";

// Installs the Turbopack worker URL-fragment shim before any effect can
// construct the local-db worker.
import "@/lib/pwa/turbopack-worker-shim";

// Critical routes to warm for offline-first experience.
// The first navigation of a session completes before the service worker
// takes control, so that page's HTML is never runtime-cached — an offline
// reload of it would hit the /~offline fallback. Warming these URLs
// through Serwist's CACHE_URLS message closes that gap.
const CRITICAL_ROUTES = [
  "/",
  "/review",
  "/words",
  "/review-history",
  "/dictionary",
  "/login",
  "/signup",
];

export function SWWarmup() {
  const { serwist } = useSerwist();

  useEffect(() => {
    if (!serwist) return;
    const urls = CRITICAL_ROUTES.map((route) => new URL(route, window.location.origin).href);
    serwist.messageSW({
      type: "CACHE_URLS",
      payload: { urlsToCache: urls },
    });
  }, [serwist]);

  return null;
}
