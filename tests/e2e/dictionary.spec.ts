import { test, expect } from "@playwright/test";

test.describe("Dictionary Lookup", () => {
  test("should look up a word and show definition", async ({ page }) => {
    await page.goto("/");

    const wordInput = page.locator('input[placeholder="Enter a word to translate..."]');
    await expect(wordInput).toBeVisible();

    await wordInput.fill("hello");
    await page.locator('button:has-text("Look Up")').click();

    await page.waitForSelector(".definition", { timeout: 10000 });
    await expect(page.locator(".definition")).toHaveText(/hello/);
  });

  test("should show error for empty word", async ({ page }) => {
    await page.goto("/");

    const wordInput = page.locator('input[placeholder="Enter a word to translate..."]');
    await wordInput.fill("");
    await page.locator('button:has-text("Look Up")').click();

    await page.waitForSelector("role=alert", { timeout: 5000 });
    await expect(page.locator("role=alert")).toHaveText(/required/);
  });

  test("should swap source and target languages", async ({ page }) => {
    await page.goto("/");

    const sourceSelect = page.locator("select").first();
    const targetSelect = page.locator("select").nth(1);

    await sourceSelect.selectOption("zh-CN");
    await targetSelect.selectOption("en");

    await page.locator('button[aria-label="Swap languages"]').click();

    await expect(sourceSelect).toHaveValue("en");
    await expect(targetSelect).toHaveValue("zh-CN");
  });
});