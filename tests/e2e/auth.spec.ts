import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "password123";

function uniqueEmail(prefix: string): string {
  const nonce = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}.${nonce}@test.local`;
}

async function signUp(page: Page, email: string, password = PASSWORD) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("Authentication", () => {
  test("protected pages redirect signed-out visitors, dictionary stays public", async ({
    page,
  }) => {
    for (const path of ["/review", "/words", "/review-history"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    }

    await page.goto("/dictionary");
    await expect(page).toHaveURL(/\/dictionary$/);
    await expect(
      page.getByPlaceholder("Enter a word to translate...")
    ).toBeVisible();
  });

  test("signing up creates an account and opens the app", async ({ page }) => {
    const email = uniqueEmail("signup");

    await signUp(page, email);

    await expect(page).toHaveURL(/\/review$/);
    // NavBar renders the account twice (desktop + mobile menus).
    await expect(page.getByRole("banner").getByText(email).first()).toBeVisible();
    await expect(page.getByRole("banner").getByText("Sign out").first()).toBeVisible();
  });

  test("signing out and back in round trips", async ({ page }) => {
    const email = uniqueEmail("roundtrip");
    await signUp(page, email);
    await expect(page).toHaveURL(/\/review$/);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // The session is really gone: a protected page bounces again.
    await page.goto("/words");
    await expect(page).toHaveURL(/\/login(\?|$)/);

    await signIn(page, email);
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByRole("banner").getByText(email).first()).toBeVisible();
  });

  test("returns to the requested page after signing in", async ({ page }) => {
    const email = uniqueEmail("redirect");
    await signUp(page, email);
    await expect(page).toHaveURL(/\/review$/);
    await page.request.post("/api/auth/logout");

    await page.goto("/words?filter=new");
    await expect(page).toHaveURL(/\/login\?next=/);
    expect(new URL(page.url()).searchParams.get("next")).toBe("/words?filter=new");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/words\?filter=new$/);
  });

  test("each account only sees its own vocabulary", async ({
    page,
    browser,
  }) => {
    const alice = uniqueEmail("alice");
    await signUp(page, alice);
    await expect(page).toHaveURL(/\/review$/);

    const created = await page.request.post("/api/words", {
      data: {
        word: "ephemeral",
        translation: "短暫的",
        sourceLanguage: "en",
        targetLanguage: "zh-TW",
      },
    });
    expect(created.status()).toBe(201);
    const word = await created.json();

    await page.goto("/words");
    await expect(page.getByText("ephemeral")).toBeVisible();

    // A second account gets a fresh, empty vocabulary and cannot reach Alice's word.
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await signUp(bobPage, uniqueEmail("bob"));
    await expect(bobPage).toHaveURL(/\/review$/);

    await bobPage.goto("/words");
    await expect(bobPage.getByText("No words saved yet")).toBeVisible();
    await expect(bobPage.getByText("ephemeral")).toBeHidden();

    const stolen = await bobPage.request.get(`/api/words?id=${word.id}`);
    expect(stolen.status()).toBe(404);

    await bobContext.close();
  });

  test("word and review APIs reject signed-out callers", async ({ request }) => {
    expect((await request.get("/api/words")).status()).toBe(401);
    expect((await request.get("/api/reviews?action=stats")).status()).toBe(401);
    expect(
      (
        await request.post("/api/words", {
          data: { word: "sneaky", translation: "偷偷的" },
        })
      ).status()
    ).toBe(401);
  });

  test("rejects an email that already signed up", async ({ page }) => {
    const email = uniqueEmail("duplicate");
    await signUp(page, email);
    await expect(page).toHaveURL(/\/review$/);

    // Signed-in visitors are redirected away from /signup, so sign out first.
    await page.request.post("/api/auth/logout");
    await signUp(page, email);

    await expect(page.getByText("Email already registered")).toBeVisible();
  });

  test("rejects a wrong password", async ({ page }) => {
    const email = uniqueEmail("wrongpassword");
    await signUp(page, email);
    await expect(page).toHaveURL(/\/review$/);

    await page.request.post("/api/auth/logout");
    await signIn(page, email, "definitely-not-the-password");

    await expect(page.getByText("Invalid email or password")).toBeVisible();
  });
});
