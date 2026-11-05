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

async function addWords(
  page: Page,
  words: Array<{ word: string; translation: string }>
) {
  const res = await page.request.post("/api/words", {
    data: words.map((w) => ({
      ...w,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    })),
  });
  expect(res.status()).toBe(201);
  return res.json() as Promise<{
    imported: number;
    results: Array<{ word: string; success: boolean; id?: number }>;
  }>;
}

test("review history loads in pages instead of fetching every record", async ({
  page,
}) => {
  const email = uniqueEmail("historypage");
  await signUp(page, email);

  const words = Array.from({ length: 32 }, (_, i) => ({
    word: `history-word-${String(i + 1).padStart(2, "0")}`,
    translation: `翻譯 ${i + 1}`,
  }));
  const { results } = await addWords(page, words);
  const rated: number[] = [];

  for (const result of results) {
    expect(result.success).toBe(true);
    const res = await page.request.post("/api/reviews", {
      data: { wordId: result.id, rating: "good" },
    });
    expect(res.status()).toBe(200);
    rated.push(result.id!);
  }

  // Page 1: newest 30 entries, with a cursor for the rest.
  const firstPage = await (
    await page.request.get(
      "/api/reviews?action=history&limit=30&offset=0"
    )
  ).json();
  expect(firstPage.total).toBe(32);
  expect(firstPage.history).toHaveLength(30);
  expect(firstPage.hasMore).toBe(true);
  expect(firstPage.history[0].wordId).toBe(rated[rated.length - 1]);

  // Page 2: the remaining 2 entries.
  const secondPage = await (
    await page.request.get(
      "/api/reviews?action=history&limit=30&offset=30"
    )
  ).json();
  expect(secondPage.total).toBe(32);
  expect(secondPage.history).toHaveLength(2);
  expect(secondPage.hasMore).toBe(false);
  expect(secondPage.history[secondPage.history.length - 1].wordId).toBe(
    rated[0]
  );

  // UI keeps the same paging behaviour.
  await page.goto("/review-history");
  await expect(page.locator("tbody tr")).toHaveCount(30, { timeout: 10000 });

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator("tbody tr")).toHaveCount(32, { timeout: 10000 });
  await expect(page.getByText("Loading more history...")).toHaveCount(0);
});
