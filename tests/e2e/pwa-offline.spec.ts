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

const OFFLINE_FAILURE =
  /Offline mode is unavailable|Missing worker bootstrap config/i;

function collectOfflineFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && OFFLINE_FAILURE.test(msg.text())) {
      failures.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    if (OFFLINE_FAILURE.test(err.message)) failures.push(err.message);
  });
  return failures;
}

test.describe("PWA offline (production build + service worker)", () => {
  test("app pages visited online stay fully usable offline", async ({
    page,
    context,
  }) => {
    const failures = collectOfflineFailures(page);
    const email = uniqueEmail("pwa");
    await signUp(page, email);
    await addWords(page, [
      { word: "alpha", translation: "阿爾法" },
      { word: "beta", translation: "貝塔" },
    ]);

    // The service worker must be active and controlling the page before
    // going offline, with precache install and the page warm-up settled.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
      undefined,
      { timeout: 20000 },
    );
    await page.waitForTimeout(2000);

    // Browse every app page once online (single full load each, like a real
    // session), so their HTML and worker assets get runtime-cached.
    for (const path of ["/words", "/review", "/review-history", "/dictionary"]) {
      await page.goto(path, { waitUntil: "load" });
    }
    await page.waitForTimeout(1500);

    await context.setOffline(true);

    for (const path of ["/words", "/review", "/review-history", "/dictionary"]) {
      await page.goto(path, { waitUntil: "load", timeout: 20000 });
      await expect(page.locator("nav")).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(/Offline mode is unavailable/)).toHaveCount(0);
    }

    // The local database must actually boot offline: the words list renders
    // from on-device data and the review queue serves the queued words.
    await page.goto("/words", { waitUntil: "load", timeout: 20000 });
    await expect(page.locator("h3").first()).toBeVisible({ timeout: 15000 });

    await page.goto("/review", { waitUntil: "load", timeout: 20000 });
    await expect(page.getByText(/New Word 1 of 2/)).toBeVisible({
      timeout: 15000,
    });

    expect(failures).toEqual([]);
  });
});
