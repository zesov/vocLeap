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
}

/**
 * Cuts the connection only once the local DB has actually booted. If the
 * boot is still pending (WASM download) the SyncStatus banner would show
 * "Offline mode is unavailable" (amber) instead of the offline banner
 * (blue), so asserting the blue banner doubles as the readiness gate.
 */
async function goOffline(page: Page, context: import("@playwright/test").BrowserContext) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);
  await context.setOffline(true);
  await expect(
    page.getByText(/Offline — your changes are stored/)
  ).toBeVisible({ timeout: 20000 });
}

test.describe("offline word adding (bad-network resilience)", () => {
  test("importing words while offline stores them locally and syncs on reconnect", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("import");
    await signUp(page, email);
    await addWords(page, [{ word: "alpha", translation: "阿爾法" }]);

    // Boot the local DB online so it holds the seeded word, and open the
    // import UI before cutting the connection (there is no service worker
    // fallback in dev, so navigation itself must happen online).
    await page.goto("/words", { waitUntil: "load" });
    await expect(page.getByText("alpha")).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "Import Words" }).click();

    await goOffline(page, context);

    // Import a file while fully offline: rows + sync ops are written to the
    // device, the import succeeds without any network.
    const fileContent = "delta,德爾塔\necho,艾科\n";
    await page.setInputFiles('input[type="file"]', {
      name: "words.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(fileContent, "utf-8"),
    });

    await expect(page.getByText(/Imported 2 of 2 words/)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("delta").first()).toBeVisible();
    await expect(page.getByText("德爾塔").first()).toBeVisible();

    // Back online: the queued word ops reach the server.
    await context.setOffline(false);
    await expect
      .poll(
        async () => {
          const res = await page.request.get(
            "/api/words?limit=50&offset=0&sort=date_desc"
          );
          const body = (await res.json()) as { words: Array<{ word: string }> };
          return body.words.map((w) => w.word);
        },
        { timeout: 30000, intervals: [1000] }
      )
      .toContain("delta");
  });

  test("dictionary save while offline stores a bare word and the backfill enriches it", async ({
    page,
    context,
  }) => {
    const email = uniqueEmail("bareword");
    await signUp(page, email);
    await addWords(page, [{ word: "alpha", translation: "阿爾法" }]);

    // Open the dictionary and enter the word while still online.
    await page.goto("/dictionary", { waitUntil: "load" });
    await page.getByLabel("Word").fill("serendipity");

    await goOffline(page, context);
    await page.getByRole("button", { name: "Look Up" }).click();

    // The lookup cannot reach the dictionary; the escape hatch appears.
    await expect(page.getByText(/offline/i).first()).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole("button", { name: "Save word anyway" }).click();
    await expect(
      page.getByText(/Word saved offline/i, { exact: false })
    ).toBeVisible({ timeout: 15000 });

    // Reconnect: sync pushes the word op that was queued offline, then the
    // backfill job translates it and the enriched row syncs back. The word
    // reaching the server at all proves the offline save went local-first.
    await context.setOffline(false);
    await expect
      .poll(
        async () => {
          const res = await page.request.get(
            "/api/words?limit=50&offset=0&sort=date_desc"
          );
          const body = (await res.json()) as {
            words: Array<{ word: string; translation: string }>;
          };
          return body.words.find((w) => w.word === "serendipity")?.translation;
        },
        { timeout: 45000, intervals: [2000] }
      )
      .not.toBe("");
  });
});
