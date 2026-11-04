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
  return res.json();
}

async function rateCurrentCard(page: Page) {
  await page.getByRole("button", { name: "Show Answer" }).click();
  await expect(page.getByRole("button", { name: /Good/ })).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: /Good/ }).click();
}

test.describe("Review queue semantics", () => {
  test("`all` endpoint only returns words in the requested queue", async ({ page }) => {
    const email = uniqueEmail("queueapi");
    await signUp(page, email);
    await addWords(page, [
      { word: "alpha", translation: "阿爾法" },
      { word: "beta", translation: "貝塔" },
      { word: "gamma", translation: "伽馬" },
    ]);

    const { words } = await (await page.request.get("/api/words?limit=50")).json();
    expect(words).toHaveLength(3);
    const rated = words[0];

    // Rating a new word creates its review row and schedules it for tomorrow.
    const ratedRes = await page.request.post("/api/reviews", {
      data: { wordId: rated.id, rating: "good" },
    });
    expect(ratedRes.status()).toBe(200);

    const newQueue = await (
      await page.request.get("/api/reviews?action=all&mode=new&limit=50")
    ).json();
    expect(newQueue).toHaveLength(2);
    expect(newQueue.some((r: { wordId: number }) => r.wordId === rated.id)).toBe(false);

    const dueQueue = await (
      await page.request.get("/api/reviews?action=all&limit=50")
    ).json();
    expect(dueQueue).toHaveLength(0);
  });

  test("reloading mid-session resumes without re-queuing reviewed words", async ({
    page,
  }) => {
    const email = uniqueEmail("queuereload");
    await signUp(page, email);
    await addWords(page, [
      { word: "delta", translation: "德爾塔" },
      { word: "epsilon", translation: "艾普西龍" },
      { word: "zeta", translation: "澤塔" },
    ]);

    await page.goto("/review");
    await expect(page.getByText(/New Word 1 of 3/)).toBeVisible({ timeout: 10000 });

    await rateCurrentCard(page);
    await expect(page.getByText(/New Word 2 of 3/)).toBeVisible({ timeout: 10000 });

    // Wait until the debounced sync lands on the server before reloading.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(
            "/api/review-state?mode=new&allDevices=true"
          );
          const data = await res.json();
          return data.meta?.reviewedCount ?? -1;
        },
        { timeout: 10000 }
      )
      .toBe(1);

    await page.reload();

    // One card was already reviewed: two remain, total session length is 3.
    await expect(page.getByText(/New Word 2 of 3/)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Card 2 of 3/)).toBeVisible({ timeout: 10000 });

    const stats = await (await page.request.get("/api/reviews?action=stats")).json();
    expect(stats.newWords).toBe(2);
    expect(stats.due).toBe(0);
  });

  test("finishing a session does not resurrect words that are no longer due", async ({
    page,
  }) => {
    const email = uniqueEmail("queuecomplete");
    await signUp(page, email);
    await addWords(page, [
      { word: "eta", translation: "伊塔" },
      { word: "theta", translation: "西塔" },
    ]);

    await page.goto("/review");
    await expect(page.getByText(/New Word 1 of 2/)).toBeVisible({ timeout: 10000 });

    await rateCurrentCard(page);
    await expect(page.getByText(/New Word 2 of 2/)).toBeVisible({ timeout: 10000 });
    await rateCurrentCard(page);

    await expect(page.getByText("Session Complete!")).toBeVisible({ timeout: 10000 });

    await page.reload();

    await expect(
      page.getByText(/No words due for review right now/)
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Show Answer" })).toHaveCount(0);
  });
});
