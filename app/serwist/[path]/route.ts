import { spawnSync } from "node:child_process";
import { createSerwistRoute } from "@serwist/turbopack";

// Versions the precached offline fallback so stale HTML is never served.
const revision =
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout?.trim() ||
  crypto.randomUUID();

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({
    additionalPrecacheEntries: [{ url: "/~offline", revision }],
    swSrc: "app/sw.ts",
    useNativeEsbuild: true,
    manifestTransforms: [
      // Turbopack worker chunks bootstrap from a `#params=` URL fragment,
      // which the Cache API strips — a precached copy is unusable. They are
      // runtime-cached (query string intact) by the turbopack-workers route
      // in app/sw.ts instead.
      (manifest) => ({
        manifest: manifest.filter(
          (entry) => !entry.url.includes("/turbopack-worker-"),
        ),
      }),
    ],
  });
