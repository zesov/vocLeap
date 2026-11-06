import { test, expect } from "@playwright/test";

test.describe("Dictionary source badges", () => {
  test("shows Wiktionary source badges for definitions and translation", async ({ page }) => {
    await page.goto("http://localhost:3102/dictionary");
    await page.fill('input[placeholder="Enter a word to translate..."]', "blatant");
    await page.click('button[type="submit"]');

    // Wait for result to appear
    await expect(page.locator("text=blatant").first()).toBeVisible({ timeout: 10000 });

    // Check translation source badge (Wiktionary) - should be an <a> with href
    const translationBadge = page.locator('[title="Source: Wiktionary"]').first();
    await expect(translationBadge).toBeVisible();
    await expect(translationBadge).toHaveAttribute("href", /zh\.wiktionary/);

    // Check definitions source badge (Wiktionary) - should also be an <a> with href
    const defsBadge = page.locator('[title="Source: Wiktionary"]').nth(1);
    await expect(defsBadge).toBeVisible();
    await expect(defsBadge).toHaveAttribute("href", /en\.wiktionary/);
  });

  test("shows Google Translate source badge when Wiktionary has no result", async ({ page }) => {
    await page.goto("http://localhost:3102/dictionary");
    await page.fill('input[placeholder="Enter a word to translate..."]', "xyzzyplugh");
    await page.click('button[type="submit"]');

    // Wait for result to appear
    await expect(page.locator("text=xyzzyplugh").first()).toBeVisible({ timeout: 10000 });

    // Check translation source badge (Google Translate, not clickable)
    const googleBadge = page.locator('[title="Source: Google Translate"]');
    await expect(googleBadge).toBeVisible();
    await expect(googleBadge).not.toHaveAttribute("href");

    // Definitions should not be shown (empty)
    const defsHeading = page.locator("text=Definitions");
    await expect(defsHeading).not.toBeVisible();
  });
});
