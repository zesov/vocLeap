import type { NextConfig } from "next";
import { withSerwist } from "@serwist/turbopack";

const nextConfig: NextConfig = {
  experimental: {
    agentFeedback: false,
  },
  // `next dev` takes an exclusive lock at `<distDir>/lock`, so two dev servers
  // cannot share a build directory. Pointing the Playwright webServer at its own
  // distDir lets it run next to the developer's dev server instead of replacing it.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  allowedDevOrigins: ["upc-0006"],
};

// Runtime caching strategies live in `app/sw.ts`; Serwist compiles the
// service worker via `app/serwist/[path]/route.ts` (Turbopack-compatible).
export default withSerwist(nextConfig);