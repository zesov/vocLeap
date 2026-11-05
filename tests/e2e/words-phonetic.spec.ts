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

test("words page shows the phonetic for saved words", async ({ page }) => {
  const email = uniqueEmail("wordsphonetic");
  await signUp(page, email);

  const res = await page.request.post("/api/words", {
    data: [
      {
        word: "blatant",
        translation: "明目張膽的",
        phonetic: "/ˈbleɪtənt/",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      },
      {
        word: "hello",
        translation: "你好",
        phonetic: "həˈloʊ",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      },
      {
        word: "quiet",
        translation: "安靜",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      },
    ],
  });
  expect(res.status()).toBe(201);

  await page.goto("/words");
  await expect(page.getByRole("heading", { name: "blatant" })).toBeVisible({
    timeout: 10000,
  });

  // Already-delimited phonetics are shown as-is…
  await expect(page.getByText("/ˈbleɪtənt/", { exact: true })).toBeVisible();
  // …while bare ones get the conventional surrounding slashes.
  await expect(page.getByText("/həˈloʊ/", { exact: true })).toBeVisible();

  // Words without a phonetic render no extra line.
  await expect(page.locator("p").filter({ hasText: /^\// })).toHaveCount(2);
});
