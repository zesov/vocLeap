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

  test("session total counts the whole backlog, not just the fetched page", async ({
    page,
  }) => {
    const email = uniqueEmail("backlog");
    await signUp(page, email);
    // 60 new words: the queue fetch (limit 50) cannot return them all.
    await addWords(
      page,
      Array.from({ length: 60 }, (_, i) => ({
        word: `backlog${String(i).padStart(2, "0")}`,
        translation: `詞${i}`,
      }))
    );

    await page.goto("/review");
    // The header must show the full session backlog (done + live remaining
    // from stats, uncapped), not just restored-count + fetched-queue size.
    await expect(page.getByText("New Word 1 of 60", { exact: true })).toBeVisible({
      timeout: 10000,
    });

    await rateCurrentCard(page);
    await expect(page.getByText("New Word 2 of 60", { exact: true })).toBeVisible({
      timeout: 10000,
    });

    await expect
      .poll(async () => {
        const res = await page.request.get("/api/review-state?mode=new&allDevices=true");
        return (await res.json()).meta?.reviewedCount ?? -1;
      }, { timeout: 10000 })
      .toBe(1);

    await page.reload();
    await expect(page.getByText("New Word 2 of 60", { exact: true })).toBeVisible({
      timeout: 10000,
    });
  });

  test("cross-day session state is dropped instead of resurrected", async ({ page }) => {
    const email = uniqueEmail("stalestate");
    await signUp(page, email);
    const created = await addWords(page, [
      { word: "ashen", translation: "灰白" },
      { word: "ample", translation: "充足" },
      { word: "aptly", translation: "恰當" },
    ]);
    const wordIds = (created.results as Array<{ id?: number }>).map((r) => r.id ?? 0);

    // Simulate session state saved yesterday claiming 45 reviewed words.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await page.evaluate(
      ([ids, ts]) => {
        const positions: Record<number, number> = {};
        (ids as number[]).forEach((id, i) => {
          positions[id] = i;
        });
        localStorage.setItem(
          "review_new_positions",
          JSON.stringify({
            positions,
            currentIndex: 0,
            reviewedCount: 45,
            updatedAt: ts,
          })
        );
      },
      [wordIds, yesterday]
    );

    await page.goto("/review");
    // A new local day is a new session: the stale reviewedCount (45) must not
    // inflate the total to 48.
    await expect(page.getByText("New Word 1 of 3", { exact: true })).toBeVisible({
      timeout: 10000,
    });
  });
});
