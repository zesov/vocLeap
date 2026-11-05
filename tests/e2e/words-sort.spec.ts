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

async function getWords(page: Page, query: string) {
  const res = await page.request.get(`/api/words?limit=30&offset=0&${query}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as {
    words: Array<{ word: string }>;
    sort: string;
    hasMore: boolean;
  };
}

test("words API sorts by date and alphabetically", async ({ page }) => {
  const email = uniqueEmail("wordssort");
  await signUp(page, email);
  await addWords(page, [
    { word: "banana", translation: "香蕉" },
    { word: "apple", translation: "蘋果" },
    { word: "cherry", translation: "車厘子" },
  ]);

  const dateDesc = await getWords(page, "sort=date_desc");
  expect(dateDesc.words.map((w) => w.word)).toEqual([
    "cherry",
    "apple",
    "banana",
  ]);

  const dateAsc = await getWords(page, "sort=date_asc");
  expect(dateAsc.words.map((w) => w.word)).toEqual([
    "banana",
    "apple",
    "cherry",
  ]);

  const alphaAsc = await getWords(page, "sort=alpha_asc");
  expect(alphaAsc.words.map((w) => w.word)).toEqual([
    "apple",
    "banana",
    "cherry",
  ]);

  const alphaDesc = await getWords(page, "sort=alpha_desc");
  expect(alphaDesc.words.map((w) => w.word)).toEqual([
    "cherry",
    "banana",
    "apple",
  ]);

  const invalid = await getWords(page, "sort=not-a-sort");
  expect(invalid.sort).toBe("date_desc");
  expect(invalid.words.map((w) => w.word)).toEqual([
    "cherry",
    "apple",
    "banana",
  ]);
});

test("words page sorts across pages while scrolling", async ({ page }) => {
  const email = uniqueEmail("wordssortui");
  await signUp(page, email);

  const words = Array.from({ length: 35 }, (_, i) => ({
    word: `word-${String(i + 1).padStart(2, "0")}`,
    translation: `詞 ${i + 1}`,
  }));
  await addWords(page, words);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/words");
  await expect(page.getByRole("heading", { name: "word-35" })).toBeVisible({
    timeout: 10000,
  });

  const sortTrigger = page.getByRole("button", { name: /Sort words/ });
  await sortTrigger.click();
  const sortList = page.getByRole("listbox");
  await expect(sortList).toBeVisible();

  // The popup must never be wider than the trigger on mobile.
  const triggerBox = await sortTrigger.boundingBox();
  const listBox = await sortList.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  expect(Math.abs(listBox!.width - triggerBox!.width)).toBeLessThan(1);

  await page.getByRole("option", { name: "A–Z", exact: true }).click();
  await expect(page.getByRole("heading", { name: "word-01" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "word-35" })).toHaveCount(0);

  // Keyboard: Enter opens, Escape closes without changing the sort.
  await sortTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(sortList).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sortList).toHaveCount(0);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.getByRole("heading", { name: "word-35" })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator("h3")).toHaveCount(35);
});
