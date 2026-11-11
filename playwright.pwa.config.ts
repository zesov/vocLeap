import { defineConfig, devices } from "@playwright/test";

// PWA offline tests need a PRODUCTION build: the service worker is disabled in
// dev (SerwistProvider disable prop), so `next dev` can never exercise it.
// Mirrors playwright.config.ts but builds first and serves the built output.
const TEST_DB = "./data/test-pwa.db";
const TEST_PORT = 3102;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const DIST_DIR = ".next-pwa-test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `rm -rf ${DIST_DIR} ${TEST_DB} ${TEST_DB}-wal ${TEST_DB}-shm && bunx next build && bunx next start -p ${TEST_PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      DB_MODE: "local",
      DB_PATH: TEST_DB,
      OWNER_EMAIL: "owner@test.local",
      NEXT_DIST_DIR: DIST_DIR,
    },
  },
});
