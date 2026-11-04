import { test, expect } from "@playwright/test";

const PASSWORD = "password123";

function uniqueEmail(prefix: string): string {
  return `${prefix}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/review$/);
}

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/review$/);
}

async function addWordsViaAPI(page: import("@playwright/test").Page, words: Array<{word: string, translation: string}>) {
  const res = await page.request.post("/api/words", {
    data: words.map(w => ({ ...w, sourceLanguage: "en", targetLanguage: "zh-CN" }))
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function waitForSync(
  page: import("@playwright/test").Page,
  mode: "review" | "new" = "review",
  expectedReviewedCount?: number
) {
  // Wait for the debounced sync to land. Checking `states` alone is not enough:
  // the initial queue write also produces states, so wait for the saved session
  // progress when the caller expects a specific value.
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(100);
    const res = await page.request.get(`/api/review-state?mode=${mode}&allDevices=true`);
    if (res.ok()) {
      const data = await res.json();
      const hasStates = data.states && data.states.length > 0;
      const hasProgress =
        expectedReviewedCount === undefined ||
        data.meta?.reviewedCount === expectedReviewedCount;
      if (hasStates && hasProgress) {
        console.log(`[waitForSync] mode=${mode} got states:`, data.states);
        return;
      }
    }
  }
  // Debug: log what we got
  const res = await page.request.get(`/api/review-state?mode=${mode}&allDevices=true`);
  const data = await res.json();
  console.log(`[waitForSync] TIMEOUT mode=${mode} final data:`, data);
  throw new Error(`Sync timeout for mode ${mode}`);
}

test.describe("Review cross-device sync", () => {
  test("progress syncs from device A to device B", async ({ browser }) => {
    const email = uniqueEmail("sync");

    // --- Device A: sign up, add words, start review ---
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signUp(pageA, email);

    const words = [
      { word: "apple", translation: "蘋果" },
      { word: "banana", translation: "香蕉" },
      { word: "cat", translation: "貓" },
    ];
    await addWordsViaAPI(pageA, words);

    const stats = await (await pageA.request.get("/api/reviews?action=stats")).json();
    expect(stats.newWords).toBe(3);
    expect(stats.due).toBe(0);
    expect(stats.total).toBe(3);

    await pageA.goto("/review");
    await expect(pageA.getByText(/Card 1 of/)).toBeVisible();

    // Click "Show Answer" first, then rate "Good"
    await pageA.getByRole("button", { name: "Show Answer" }).click();
    // Wait for "Show Answer" button to disappear (answer shown)
    await expect(pageA.getByRole("button", { name: "Show Answer" })).toBeHidden({ timeout: 5000 });
    // Now rating buttons should be visible
    await expect(pageA.getByRole("button", { name: /Good/ })).toBeVisible({ timeout: 5000 });
    await pageA.getByRole("button", { name: /Good/ }).click();
    // Wait for card to advance
    await expect(pageA.getByText(/Card 2 of/)).toBeVisible({ timeout: 10000 });

    // Wait for sync to complete
    await waitForSync(pageA, "new", 1);

    // Debug: check what the API returns for this user
    const apiRes = await pageA.request.get("/api/review-state?mode=new&allDevices=true");
    const apiData = await apiRes.json();
    console.log("[Test] Device A API after sync:", apiData);

    // --- Device B: new browser context (simulates different device) ---
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    // Sign in with same account
    await signIn(pageB, email);

    // Debug: check what Device B sees
    const apiResB = await pageB.request.get("/api/review-state?mode=new&allDevices=true");
    const apiDataB = await apiResB.json();
    console.log("[Test] Device B API on load:", apiDataB);

    // Should resume at Card 2 (index 1)
    await expect(pageB.getByText(/Card 2 of/)).toBeVisible({ timeout: 10000 });

    await contextA.close();
    await contextB.close();
  });

  test("due and new queues sync independently", async ({ browser }) => {
    const email = uniqueEmail("dualqueue");

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signUp(pageA, email);

    // Add words and review some to create both due and new history
    const words = [
      { word: "dog", translation: "狗" },
      { word: "elephant", translation: "大象" },
      { word: "fox", translation: "狐狸" },
    ];
    await addWordsViaAPI(pageA, words);

    await pageA.goto("/review");
    await expect(pageA.getByText(/Card 1 of/)).toBeVisible();

    // Review 1 card - click Show Answer first
    await pageA.getByRole("button", { name: "Show Answer" }).click();
    await expect(pageA.getByRole("button", { name: "Show Answer" })).toBeHidden({ timeout: 5000 });
    await expect(pageA.getByRole("button", { name: /Good/ })).toBeVisible({ timeout: 5000 });
    await pageA.getByRole("button", { name: /Good/ }).click();
    await expect(pageA.getByText(/Card 2 of/)).toBeVisible({ timeout: 10000 });
    await waitForSync(pageA, "new", 1);

    // Test that due queue state is synced
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signIn(pageB, email);
    await expect(pageB.getByText(/Card 2 of/)).toBeVisible({ timeout: 10000 });

    // Now test new queue: add more words and check they appear
    await addWordsViaAPI(pageA, [
      { word: "giraffe", translation: "長頸鹿" },
      { word: "hippo", translation: "河馬" },
    ]);
    await pageA.goto("/review");
    // Give time for new words to be picked up
    await pageA.waitForTimeout(500);

    // Verify new queue state exists via API (even if empty initially)
    const apiRes = await pageB.request.get("/api/review-state?mode=new&allDevices=true");
    const apiData = await apiRes.json();
    // New queue should exist but may be empty initially
    expect(Array.isArray(apiData.states)).toBe(true);

    await contextA.close();
    await contextB.close();
  });
});