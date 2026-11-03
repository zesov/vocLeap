import { test, expect } from "@playwright/test";

test.describe("Landing and dictionary", () => {
  test("landing page links to the dictionary", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Learn Vocabulary Effectively" })
    ).toBeVisible();

    await page.getByRole("link", { name: /Dictionary/ }).first().click();
    await expect(page).toHaveURL(/\/dictionary$/);
    await expect(
      page.getByPlaceholder("Enter a word to translate...")
    ).toBeVisible();
  });

  test("swaps source and target languages", async ({ page }) => {
    await page.goto("/dictionary");

    const sourceSelect = page.locator("select").first();
    const targetSelect = page.locator("select").nth(1);

    await sourceSelect.selectOption("zh-CN");
    await targetSelect.selectOption("en");

    await page.locator('button[aria-label="Swap languages"]').click();

    await expect(sourceSelect).toHaveValue("en");
    await expect(targetSelect).toHaveValue("zh-CN");
  });
});
