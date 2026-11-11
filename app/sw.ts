/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import {
  CacheableResponsePlugin,
  CacheFirst,
  ExpirationPlugin,
  NetworkOnly,
  Serwist,
} from "serwist";

// `self.__SW_MANIFEST` is a magic string replaced with the precache
// manifest at build time by Serwist's route handler.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const DAY_SECONDS = 24 * 60 * 60;

// First matching route wins: custom entries must precede `defaultCache`
// (the app skeleton: documents NetworkFirst, _next/static, fonts, ...).
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // App data must never be served from a cache: the local database is
      // the only offline source of truth for API responses.
      matcher: /\/api\//,
      handler: new NetworkOnly(),
    },
    {
      // SQLite WASM engines are versioned static assets: cache forever.
      matcher: /\/(sqlite-wasm|wa-sqlite)\//,
      handler: new CacheFirst({
        cacheName: "sqlite-wasm",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 8,
            maxAgeSeconds: 365 * DAY_SECONDS,
          }),
        ],
      }),
    },
    {
      // Google Fonts stylesheets (cross-origin, may be opaque responses).
      matcher: /^https:\/\/fonts\.googleapis\.com\/.*/i,
      handler: new CacheFirst({
        cacheName: "google-fonts",
        plugins: [
          new CacheableResponsePlugin({ statuses: [0, 200] }),
          new ExpirationPlugin({
            maxEntries: 4,
            maxAgeSeconds: 365 * DAY_SECONDS,
          }),
        ],
      }),
    },
    {
      // Google Fonts font files.
      matcher: /^https:\/\/fonts\.gstatic\.com\/.*/i,
      handler: new CacheFirst({
        cacheName: "google-fonts-static",
        plugins: [
          new CacheableResponsePlugin({ statuses: [0, 200] }),
          new ExpirationPlugin({
            maxEntries: 4,
            maxAgeSeconds: 365 * DAY_SECONDS,
          }),
        ],
      }),
    },
    {
      // Images.
      matcher: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
      handler: new CacheFirst({
        cacheName: "images",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 64,
            maxAgeSeconds: 30 * DAY_SECONDS,
          }),
        ],
      }),
    },
    {
      // Turbopack worker bootstrap chunks. They are requested with a
      // `?params=` query (rewritten from a URL fragment by
      // lib/pwa/turbopack-worker-shim.ts, which the Cache API would strip)
      // and excluded from the precache manifest, so this route is the only
      // offline source for them. The query carries the bootstrap config —
      // it must be part of the cache key, which CacheFirst preserves.
      matcher: /\/_next\/static\/chunks\/turbopack-worker-[\w-]+\.js/,
      handler: new CacheFirst({
        cacheName: "turbopack-workers",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 4,
            maxAgeSeconds: 365 * DAY_SECONDS,
          }),
        ],
      }),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

serwist.addEventListeners();
