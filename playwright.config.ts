import { defineConfig, devices } from "@playwright/test";

// Tests must never touch the real database: the developer's `.env` points at
// Turso, so force a local SQLite file here and delete it before the server boots.
const TEST_DB = "./data/test.db";
const TEST_PORT = 3101;
const BASE_URL = `http://localhost:${TEST_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    // Reset the database here rather than in globalSetup: Playwright starts the
    // webServer before running global setups, so deleting the file afterwards
    // would unlink the database the server already has open.
    command: `rm -f ${TEST_DB} ${TEST_DB}-wal ${TEST_DB}-shm && bunx next dev -p ${TEST_PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    env: {
      DB_MODE: "local",
      DB_PATH: TEST_DB,
      OWNER_EMAIL: "owner@test.local",
      // Own build directory, so this server can run alongside `bun run dev`
      // (Next.js locks a dev server to its distDir).
      NEXT_DIST_DIR: ".next-test",
    },
  },
});
