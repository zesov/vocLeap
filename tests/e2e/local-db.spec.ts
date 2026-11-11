import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "password123";

function uniqueEmail(prefix: string): string {
  const nonce = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}.${nonce}@test.local`;
}

async function signUp(page: Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/review$/);
}

async function addWords(page: Page, words: Array<{ word: string; translation: string }>) {
  const res = await page.request.post("/api/words", {
    data: words.map((w) => ({
      ...w,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    })),
  });
  expect(res.status()).toBe(201);
}

// A local database that is published before its schema exists surfaces as these
// errors, and the review queue ends up empty because the facade keeps reading
// from the broken handle.
const LOCAL_DB_FAILURE =
  /no such table|disk I\/O error|database disk image is malformed|database or disk is full/i;

function collectLocalDbFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && LOCAL_DB_FAILURE.test(msg.text())) {
      failures.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    if (LOCAL_DB_FAILURE.test(err.message)) failures.push(err.message);
  });
  return failures;
}

test.describe("local database boot", () => {
  test("a brand-new database serves the review queue without storage errors", async ({
    page,
  }) => {
    // Capture from the first paint: signing up creates and migrates the local
    // file in this page load, so the earliest queue reads race the migration.
    const failures = collectLocalDbFailures(page);

    const email = uniqueEmail("localdb");
    await signUp(page, email);
    await addWords(page, [
      { word: "alpha", translation: "阿爾法" },
      { word: "beta", translation: "貝塔" },
      { word: "gamma", translation: "伽馬" },
    ]);

    await page.goto("/review");
    await expect(page.getByText(/New Word 1 of 3/)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("button", { name: "Show Answer" })).toBeVisible();

    // A reload reads the already-migrated file.
    await page.reload();
    await expect(page.getByText(/New Word 1 of 3/)).toBeVisible({
      timeout: 15000,
    });

    expect(failures).toEqual([]);
  });
});
