# Multi-user Auth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email/password accounts and per-user data isolation so every user has a private vocabulary and review history, with the owner's existing 2008 words claimed by their account.

**Architecture:** Own `users` + `sessions` tables with scrypt password hashing and opaque HttpOnly session cookies (no new dependencies). `words.user_id` becomes the ownership boundary; `reviews` and `review_history` are isolated through a `words` join. A one-off idempotent migration rebuilds `words` to replace `UNIQUE(word)` with `UNIQUE(user_id, word)` without disabling foreign keys. APIs use a `withUser()` guard; pages use a server route-group layout that redirects to `/login`.

**Tech Stack:** Next.js 16.4.3 (App Router, Turbopack), React 19, TypeScript, Tailwind 4, better-sqlite3, @libsql/client (Turso), Node `crypto`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-03-multiuser-auth-design.md`

---

## File map

Create:

- `lib/auth/password.ts` — scrypt hash/verify
- `lib/auth/validation.ts` — email/password normalisation
- `lib/auth/session.ts` — session create/read/destroy, `SessionUser`
- `lib/auth/guard.ts` — `requireUser`, `withUser`, `UnauthorizedError`
- `lib/auth/csrf.ts` — same-origin check for mutations
- `lib/auth/rate-limit.ts` — best-effort login throttle
- `lib/auth/claim.ts` — legacy word claim
- `app/api/auth/signup/route.ts`
- `app/api/auth/login/route.ts`
- `app/api/auth/logout/route.ts`
- `app/api/auth/me/route.ts`
- `components/AuthForm.tsx`
- `app/login/page.tsx`
- `app/signup/page.tsx`
- `app/(app)/layout.tsx` — auth guard for protected pages
- `scripts/migrate-multiuser.ts`
- `scripts/claim-owner.ts`
- `.env.example`
- `tests/global-setup.ts`
- `tests/e2e/auth.spec.ts`

Modify:

- `lib/db/init.ts` — `batch()` on the adapter, `users`/`sessions` tables, new `words` shape
- `lib/db/operations.ts` — every user-data function takes `userId`
- `app/api/words/route.ts` — auth + scoping
- `app/api/reviews/route.ts` — auth + scoping
- `components/NavBar.tsx` — account state, sign out
- `components/DictionaryLookup.tsx` — 401 save message
- `app/page.tsx` — sign-in CTAs and copy
- `playwright.config.ts` — port + test DB env + global setup
- `tests/e2e/dictionary.spec.ts` — match the current landing page
- `package.json` — `migrate:multiuser`, `claim-owner` scripts
- `README.md` — auth, migration, owner recovery
- `CHANGELOG.md`

Move (no URL change):

- `app/review` → `app/(app)/review`
- `app/words` → `app/(app)/words`
- `app/review-history` → `app/(app)/review-history`

---

## Task 1: Make the Playwright harness deterministic

The existing suite points at port 3001 while `bun dev` serves 3000, and the dictionary spec still assumes the home page contains the lookup form. Fix this first so every later task can run tests.

**Files:**
- Modify: `playwright.config.ts`
- Create: `tests/global-setup.ts`
- Modify: `tests/e2e/dictionary.spec.ts`

- [ ] **Step 1: Add a global setup that deletes the test database**

Create `tests/global-setup.ts`:

```ts
import { rmSync } from "fs";

export default function globalSetup() {
  rmSync("./data/test.db", { force: true });
  rmSync("./data/test.db-wal", { force: true });
  rmSync("./data/test.db-shm", { force: true });
}
```

- [ ] **Step 2: Point Playwright at its own server and database**

Replace `playwright.config.ts` with:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  globalSetup: "./tests/global-setup.ts",
  use: {
    baseURL: "http://localhost:3001",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: "bunx next dev -p 3001",
    url: "http://localhost:3001",
    reuseExistingServer: false,
    env: {
      DB_PATH: "./data/test.db",
      OWNER_EMAIL: "owner@test.local",
    },
  },
});
```

- [ ] **Step 3: Rewrite the stale dictionary spec**

Replace `tests/e2e/dictionary.spec.ts` with:

```ts
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
```

- [ ] **Step 4: Run the suite**

Run: `bunx playwright test tests/e2e/dictionary.spec.ts --project=chromium`

Expected: 2 passed. A new `data/test.db` file exists afterwards.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts tests/global-setup.ts tests/e2e/dictionary.spec.ts
git commit -m "test: isolate playwright database and fix dictionary spec"
```

---

## Task 2: Add `batch()` to the database adapter

The migration needs one atomic write across many DDL statements on both backends.

**Files:**
- Modify: `lib/db/init.ts:19-24` (interface), `lib/db/init.ts:49-69` (local), `lib/db/init.ts:108-130` (Turso)

- [ ] **Step 1: Extend the interface**

In `lib/db/init.ts`, add `batch` to `DatabaseAdapter`:

```ts
export interface DatabaseAdapter {
  exec(sql: string): Promise<void>;
  batch(statements: string[]): Promise<void>;
  prepare(sql: string): PreparedStatement;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Remove constructor parameter properties**

Node 24's native TypeScript runner (used by the migration scripts) cannot parse
parameter properties. Rewrite the two statement constructors in `lib/db/init.ts`:

```ts
class LocalStatement implements PreparedStatement {
  private stmt: Database.Statement;

  constructor(stmt: Database.Statement) {
    this.stmt = stmt;
  }
  // ...existing run/get/all methods unchanged
}
```

```ts
class TursoStatement implements PreparedStatement {
  private client: ReturnType<typeof createClient>;
  private sql: string;

  constructor(client: ReturnType<typeof createClient>, sql: string) {
    this.client = client;
    this.sql = sql;
  }
  // ...existing run/get/all methods unchanged
}
```

- [ ] **Step 3: Implement it for local SQLite**

Inside `LocalAdapter`, after `exec`:

```ts
  async batch(statements: string[]): Promise<void> {
    const runAll = this.db.transaction(() => {
      for (const sql of statements) {
        this.db.exec(sql);
      }
    });
    runAll();
  }
```

- [ ] **Step 4: Implement it for Turso**

Inside `TursoAdapter`, after `exec`:

```ts
  async batch(statements: string[]): Promise<void> {
    await this.client.batch(statements, "write");
  }
```

- [ ] **Step 5: Allow explicit `.ts` imports in scripts**

In `tsconfig.json`, add to `compilerOptions`:

```json
    "allowImportingTsExtensions": true,
```

This is safe because the project already has `"noEmit": true`; it is required for
the Node-run migration scripts to import `../lib/db/init.ts`.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/db/init.ts tsconfig.json
git commit -m "feat: add atomic batch execution to db adapter"
```

---

## Task 3: Add `users`, `sessions`, and the final `words` shape

**Files:**
- Modify: `lib/db/init.ts:146-200`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the new tables and the final `words` shape**

Replace the body of `lib/db/init.ts` after `export const db = adapter;` with a
cached schema initialiser. Awaiting the same promise from API routes removes the
startup race where the first request could query before the tables exist:

```ts
let initPromise: Promise<void> | null = null;

async function createSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      word TEXT NOT NULL,
      translation TEXT NOT NULL,
      definitions TEXT,
      examples TEXT,
      phonetic TEXT,
      audio_url TEXT,
      source_language TEXT DEFAULT 'en',
      target_language TEXT DEFAULT 'zh-CN',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, word)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      ease_factor REAL NOT NULL DEFAULT 2.5,
      interval INTEGER NOT NULL DEFAULT 0,
      repetitions INTEGER NOT NULL DEFAULT 0,
      next_review_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_reviewed DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(word_id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS review_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL,
      previous_ease_factor REAL NOT NULL,
      previous_interval INTEGER NOT NULL,
      previous_repetitions INTEGER NOT NULL,
      new_ease_factor REAL NOT NULL,
      new_interval INTEGER NOT NULL,
      new_repetitions INTEGER NOT NULL,
      reviewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_words_word ON words(word)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_words_user ON words(user_id)`);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_reviews_next_review ON reviews(next_review_date)`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_review_history_word ON review_history(word_id)`
  );
}

export function initDatabase(): Promise<void> {
  if (!initPromise) {
    initPromise = createSchema();
  }
  return initPromise;
}

initDatabase();
```

- [ ] **Step 2: Add npm scripts**

In `package.json`, add to `"scripts"`:

```json
    "migrate:multiuser": "node scripts/migrate-multiuser.ts",
    "claim-owner": "node scripts/claim-owner.ts"
```

Node 24 runs `.ts` files natively. The scripts must not be run with `bun`:
Bun 1.3 crashes when loading the `better-sqlite3` native addon in this project.

- [ ] **Step 3: Verify a fresh database is created correctly**

Run:

```bash
rm -f /tmp/vocleap-fresh.db /tmp/vocleap-fresh.db-wal /tmp/vocleap-fresh.db-shm
DB_PATH=/tmp/vocleap-fresh.db node -e 'import("./lib/db/init.ts").then(() => new Promise((r) => setTimeout(r, 300)))'
node -e 'const Database = require("better-sqlite3"); const db = new Database("/tmp/vocleap-fresh.db"); console.log(db.prepare("PRAGMA table_info(words)").all().map((c) => c.name).join(",")); db.close();' | grep user_id
```

Expected: one line containing `user_id`.

- [ ] **Step 4: Commit**

```bash
git add lib/db/init.ts package.json
git commit -m "feat: add users, sessions, and per-user words schema"
```

---

## Task 4: Write the idempotent multi-user migration script

Rebuilds `words` for existing databases. It never disables foreign keys: children are dropped before the parent, and FK references follow the renames.

**Files:**
- Create: `scripts/migrate-multiuser.ts`

- [ ] **Step 1: Write the script**

Create `scripts/migrate-multiuser.ts`:

```ts
import { db, initDatabase } from "../lib/db/init.ts";

const REBUILD_STATEMENTS = [
  `DROP TABLE IF EXISTS review_history_migrated`,
  `DROP TABLE IF EXISTS reviews_migrated`,
  `DROP TABLE IF EXISTS words_migrated`,

  `CREATE TABLE words_migrated (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    word TEXT NOT NULL,
    translation TEXT NOT NULL,
    definitions TEXT,
    examples TEXT,
    phonetic TEXT,
    audio_url TEXT,
    source_language TEXT DEFAULT 'en',
    target_language TEXT DEFAULT 'zh-CN',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, word)
  )`,

  `INSERT INTO words_migrated
    (id, word, translation, definitions, examples, phonetic, audio_url,
     source_language, target_language, created_at, updated_at)
   SELECT id, word, translation, definitions, examples, phonetic, audio_url,
          source_language, target_language, created_at, updated_at
   FROM words`,

  `CREATE TABLE reviews_migrated (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL REFERENCES words_migrated(id) ON DELETE CASCADE,
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval INTEGER NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    next_review_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_reviewed DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(word_id)
  )`,

  `INSERT INTO reviews_migrated
    (id, word_id, ease_factor, interval, repetitions, next_review_date,
     last_reviewed, created_at, updated_at)
   SELECT id, word_id, ease_factor, interval, repetitions, next_review_date,
          last_reviewed, created_at, updated_at
   FROM reviews`,

  `CREATE TABLE review_history_migrated (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL REFERENCES words_migrated(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL,
    previous_ease_factor REAL NOT NULL,
    previous_interval INTEGER NOT NULL,
    previous_repetitions INTEGER NOT NULL,
    new_ease_factor REAL NOT NULL,
    new_interval INTEGER NOT NULL,
    new_repetitions INTEGER NOT NULL,
    reviewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `INSERT INTO review_history_migrated
    (id, word_id, rating, previous_ease_factor, previous_interval,
     previous_repetitions, new_ease_factor, new_interval, new_repetitions,
     reviewed_at)
   SELECT id, word_id, rating, previous_ease_factor, previous_interval,
          previous_repetitions, new_ease_factor, new_interval, new_repetitions,
          reviewed_at
   FROM review_history`,

  `DROP TABLE review_history`,
  `DROP TABLE reviews`,
  `DROP TABLE words`,

  `ALTER TABLE words_migrated RENAME TO words`,
  `ALTER TABLE reviews_migrated RENAME TO reviews`,
  `ALTER TABLE review_history_migrated RENAME TO review_history`,

  `CREATE INDEX IF NOT EXISTS idx_words_word ON words(word)`,
  `CREATE INDEX IF NOT EXISTS idx_words_user ON words(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_next_review ON reviews(next_review_date)`,
  `CREATE INDEX IF NOT EXISTS idx_review_history_word ON review_history(word_id)`,
];

async function wordsHasColumn(column: string): Promise<boolean> {
  const rows = await db.prepare("PRAGMA table_info(words)").all();
  return rows.some((row) => String(row.name) === column);
}

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.count ?? 0);
}

async function main() {
  await initDatabase();

  if (await wordsHasColumn("user_id")) {
    console.log("words.user_id already exists — nothing to do.");
    return;
  }

  const beforeWords = await count("words");
  const beforeReviews = await count("reviews");
  const beforeHistory = await count("review_history");

  console.log(
    `Migrating ${beforeWords} words, ${beforeReviews} reviews, ${beforeHistory} history rows...`
  );

  await db.batch(REBUILD_STATEMENTS);

  const afterWords = await count("words");
  const afterReviews = await count("reviews");
  const afterHistory = await count("review_history");

  if (
    afterWords !== beforeWords ||
    afterReviews !== beforeReviews ||
    afterHistory !== beforeHistory
  ) {
    throw new Error(
      `Row count mismatch after migration: words ${beforeWords}→${afterWords}, ` +
        `reviews ${beforeReviews}→${afterReviews}, history ${beforeHistory}→${afterHistory}`
    );
  }

  console.log(
    `Migration complete: words ${afterWords}, reviews ${afterReviews}, history ${afterHistory}.`
  );
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
```

- [ ] **Step 2: Build a legacy database fixture**

Run:

```bash
rm -f /tmp/vocleap-legacy.db*
node -e '
const Database = require("better-sqlite3");
const db = new Database("/tmp/vocleap-legacy.db");
db.exec(`
  CREATE TABLE words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL UNIQUE, translation TEXT NOT NULL, definitions TEXT, examples TEXT, phonetic TEXT, audio_url TEXT, source_language TEXT DEFAULT "en", target_language TEXT DEFAULT "zh-CN", created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE, ease_factor REAL NOT NULL DEFAULT 2.5, interval INTEGER NOT NULL DEFAULT 0, repetitions INTEGER NOT NULL DEFAULT 0, next_review_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_reviewed DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(word_id));
  CREATE TABLE review_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE, rating INTEGER NOT NULL, previous_ease_factor REAL NOT NULL, previous_interval INTEGER NOT NULL, previous_repetitions INTEGER NOT NULL, new_ease_factor REAL NOT NULL, new_interval INTEGER NOT NULL, new_repetitions INTEGER NOT NULL, reviewed_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  INSERT INTO words (word, translation) VALUES ("apple", "蘋果"), ("banana", "香蕉");
  INSERT INTO reviews (word_id, ease_factor, interval, repetitions) VALUES (1, 2.5, 1, 1);
  INSERT INTO review_history (word_id, rating, previous_ease_factor, previous_interval, previous_repetitions, new_ease_factor, new_interval, new_repetitions) VALUES (1, 4, 2.5, 0, 0, 2.6, 1, 1);
`);
db.close();
'
```

Expected: no output, `/tmp/vocleap-legacy.db` exists.

- [ ] **Step 3: Run the migration against the fixture**

Run:

```bash
DB_PATH=/tmp/vocleap-legacy.db node scripts/migrate-multiuser.ts
```

Expected output ends with: `Migration complete: words 2, reviews 1, history 1.`

- [ ] **Step 4: Verify constraints and idempotency**

Run:

```bash
node -e 'const Database = require("better-sqlite3"); const db = new Database("/tmp/vocleap-legacy.db"); console.log(db.prepare("PRAGMA table_info(words)").all().map((c) => c.name).join(",")); console.log(db.prepare("SELECT word, user_id FROM words ORDER BY id").all()); db.close();'
DB_PATH=/tmp/vocleap-legacy.db node scripts/migrate-multiuser.ts
```

Expected:
- the column list contains `user_id`
- `[ { word: 'apple', user_id: null }, { word: 'banana', user_id: null } ]`
- second run prints `words.user_id already exists — nothing to do.`

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-multiuser.ts
git commit -m "feat: add idempotent multi-user words migration"
```

---

## Task 5: Add password, validation, CSRF, and rate-limit helpers

**Files:**
- Create: `lib/auth/validation.ts`
- Create: `lib/auth/password.ts`
- Create: `lib/auth/csrf.ts`
- Create: `lib/auth/rate-limit.ts`

- [ ] **Step 1: Write email/password validation**

Create `lib/auth/validation.ts`:

```ts
export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;

  const value = email.trim().toLowerCase();
  if (value.length === 0 || value.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;

  return value;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") return null;
  if (password.length < 8 || password.length > 200) return null;
  return password;
}
```

- [ ] **Step 2: Write scrypt hashing**

Create `lib/auth/password.ts`:

```ts
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MAX_MEM = 64 * 1024 * 1024;

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });

  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);

  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n <= 0 ||
    r <= 0 ||
    p <= 0 ||
    n > 1048576 ||
    r > 32 ||
    p > 32
  ) {
    return false;
  }

  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await scryptAsync(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: MAX_MEM,
  });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

- [ ] **Step 3: Write the same-origin check**

Create `lib/auth/csrf.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";

export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === request.nextUrl.origin;
}

export function badOriginResponse(): NextResponse {
  return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
}
```

- [ ] **Step 4: Write the throttle**

Create `lib/auth/rate-limit.ts`:

```ts
import { NextRequest } from "next/server";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_BUCKETS = 1000;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function prune(now: number) {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function clientKey(request: NextRequest, email: string): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return `${ip}:${email.trim().toLowerCase()}`;
}

export function throttle(key: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  prune(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}
```

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/auth/password.ts lib/auth/validation.ts lib/auth/csrf.ts lib/auth/rate-limit.ts
git commit -m "feat: add password hashing, validation, csrf, and throttle helpers"
```

---

## Task 6: Add sessions, the request guard, and legacy claim

**Files:**
- Create: `lib/auth/session.ts`
- Create: `lib/auth/guard.ts`
- Create: `lib/auth/claim.ts`

- [ ] **Step 1: Write the session module**

Create `lib/auth/session.ts`:

```ts
import { cookies } from "next/headers";
import { createHash, randomBytes } from "crypto";
import { db, initDatabase } from "@/lib/db/init";

export const SESSION_COOKIE = "vocleap_session";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionUser = {
  id: number;
  email: string;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: number): Promise<void> {
  await initDatabase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db
    .prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)")
    .run(userId, hashToken(token), expiresAt.toISOString());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  await initDatabase();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);
  const row = await db
    .prepare(
      `SELECT u.id AS id, u.email AS email, s.expires_at AS expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash);

  if (!row) return null;

  const expiresAt = new Date(String(row.expires_at));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }

  return { id: Number(row.id), email: String(row.email) };
}

export async function destroySession(): Promise<void> {
  await initDatabase();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    await db
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(hashToken(token));
  }

  store.delete(SESSION_COOKIE);
}
```

- [ ] **Step 2: Write the API guard**

Create `lib/auth/guard.ts`:

```ts
import { NextResponse } from "next/server";
import { getCurrentUser, type SessionUser } from "./session";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export async function withUser(
  handler: (user: SessionUser) => Promise<Response>
): Promise<Response> {
  try {
    return await handler(await requireUser());
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }
}
```

- [ ] **Step 3: Write the legacy claim**

Create `lib/auth/claim.ts`:

```ts
import { db } from "@/lib/db/init";
import type { SessionUser } from "./session";

export async function claimLegacyWords(user: SessionUser): Promise<number> {
  const ownerEmail = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
  if (!ownerEmail) return 0;
  if (user.email.trim().toLowerCase() !== ownerEmail) return 0;

  const usersRow = await db.prepare("SELECT COUNT(*) AS count FROM users").get();
  if (Number(usersRow?.count ?? 0) !== 1) return 0;

  const result = await db
    .prepare("UPDATE words SET user_id = ? WHERE user_id IS NULL")
    .run(user.id);

  return result.changes;
}
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/session.ts lib/auth/guard.ts lib/auth/claim.ts
git commit -m "feat: add session handling, request guard, and owner claim"
```

---

## Task 7: Add the auth API routes

**Files:**
- Create: `app/api/auth/signup/route.ts`
- Create: `app/api/auth/login/route.ts`
- Create: `app/api/auth/logout/route.ts`
- Create: `app/api/auth/me/route.ts`

- [ ] **Step 1: Write signup**

Create `app/api/auth/signup/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db/init";
import { hashPassword } from "@/lib/auth/password";
import { createSession, type SessionUser } from "@/lib/auth/session";
import { normalizeEmail, validatePassword } from "@/lib/auth/validation";
import { badOriginResponse, isSameOrigin } from "@/lib/auth/csrf";
import { clientKey, throttle } from "@/lib/auth/rate-limit";
import { claimLegacyWords } from "@/lib/auth/claim";

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/i.test(error.message)
  );
}

export async function POST(request: NextRequest) {
  try {
    if (!isSameOrigin(request)) return badOriginResponse();

    await initDatabase();

    const body = await request.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const password = validatePassword(body?.password);

    if (!email || !password) {
      return NextResponse.json(
        {
          error:
            "Enter a valid email and a password of at least 8 characters",
        },
        { status: 400 }
      );
    }

    const limit = throttle(clientKey(request, email));
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: "Too many attempts. Try again later.",
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        { status: 429 }
      );
    }

    const existing = await db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email);
    if (existing) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(password);
    const result = await db
      .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(email, passwordHash);

    const user: SessionUser = {
      id: Number(result.lastInsertRowid),
      email,
    };

    await createSession(user.id);
    await claimLegacyWords(user);

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 }
      );
    }
    console.error("Signup error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Write login**

Create `app/api/auth/login/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db/init";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, type SessionUser } from "@/lib/auth/session";
import { normalizeEmail } from "@/lib/auth/validation";
import { badOriginResponse, isSameOrigin } from "@/lib/auth/csrf";
import { clientKey, throttle } from "@/lib/auth/rate-limit";
import { claimLegacyWords } from "@/lib/auth/claim";

export async function POST(request: NextRequest) {
  try {
    if (!isSameOrigin(request)) return badOriginResponse();

    await initDatabase();

    const body = await request.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === "string" ? body.password : null;

    if (!email || !password) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    const limit = throttle(clientKey(request, email));
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: "Too many attempts. Try again later.",
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        { status: 429 }
      );
    }

    const row = await db
      .prepare(
        "SELECT id, email, password_hash FROM users WHERE email = ?"
      )
      .get(email);

    const valid =
      row !== null &&
      (await verifyPassword(password, String(row.password_hash)));

    if (!valid || !row) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    const user: SessionUser = {
      id: Number(row.id),
      email: String(row.email),
    };

    await createSession(user.id);
    await claimLegacyWords(user);

    return NextResponse.json({ user });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Write logout and me**

Create `app/api/auth/logout/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/auth/session";
import { badOriginResponse, isSameOrigin } from "@/lib/auth/csrf";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return badOriginResponse();

  await destroySession();
  return new NextResponse(null, { status: 204 });
}
```

Create `app/api/auth/me/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ user });
}
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Smoke-test with curl**

Start the server in one shell:

```bash
DB_PATH=/tmp/vocleap-auth.db OWNER_EMAIL=owner@test.local bunx next dev -p 3001
```

In another shell:

```bash
curl -i -c /tmp/vocleap-cookies.txt -H "Content-Type: application/json" \
  -d '{"email":"owner@test.local","password":"password123"}' \
  http://localhost:3001/api/auth/signup
curl -i -b /tmp/vocleap-cookies.txt http://localhost:3001/api/auth/me
```

Expected: signup returns `201` with `{"user":{"id":1,"email":"owner@test.local"}}`; `me` returns `200` with the same user.

- [ ] **Step 6: Commit**

```bash
git add app/api/auth
git commit -m "feat: add signup, login, logout, and me endpoints"
```

---

## Task 8: Add login/signup pages and account state in NavBar

**Files:**
- Create: `components/AuthForm.tsx`
- Create: `app/login/page.tsx`
- Create: `app/signup/page.tsx`
- Modify: `components/NavBar.tsx`

- [ ] **Step 1: Write the shared auth form**

Create `components/AuthForm.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

type AuthMode = "login" | "signup";

interface AuthFormProps {
  mode: AuthMode;
  next: string;
}

const COPY = {
  login: {
    title: "Sign in",
    submit: "Sign in",
    switchText: "Need an account?",
    switchHref: "/signup",
    switchLabel: "Create one",
  },
  signup: {
    title: "Create account",
    submit: "Create account",
    switchText: "Already have an account?",
    switchHref: "/login",
    switchLabel: "Sign in",
  },
} as const;

export function AuthForm({ mode, next }: AuthFormProps) {
  const router = useRouter();
  const copy = COPY[mode];

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(
          typeof data.error === "string" ? data.error : "Something went wrong"
        );
        return;
      }

      router.push(next);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />

      <Input
        label="Password"
        type="password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        helperText={
          mode === "signup" ? "At least 8 characters." : undefined
        }
        required
      />

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <Button type="submit" loading={submitting} className="w-full" size="lg">
        {copy.submit}
      </Button>

      <p className="text-center text-sm text-gray-600 dark:text-gray-400">
        {copy.switchText}{" "}
        <Link
          href={copy.switchHref}
          className="font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          {copy.switchLabel}
        </Link>
      </p>
    </form>
  );
}
```

- [ ] **Step 2: Write the login page**

Create `app/login/page.tsx`:

```tsx
import NavBar from "@/components/NavBar";
import { AuthForm } from "@/components/AuthForm";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";

function safeNext(value: string | undefined): string {
  if (!value) return "/review";
  if (!value.startsWith("/") || value.startsWith("//")) return "/review";
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(Array.isArray(next) ? next[0] : next);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <NavBar />
      <div className="mx-auto max-w-md px-4 py-8 sm:px-6">
        <Card variant="outlined">
          <CardHeader>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">
              Sign in
            </h1>
          </CardHeader>
          <CardContent>
            <AuthForm mode="login" next={target} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the signup page**

Create `app/signup/page.tsx`:

```tsx
import NavBar from "@/components/NavBar";
import { AuthForm } from "@/components/AuthForm";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";

export default function SignupPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <NavBar />
      <div className="mx-auto max-w-md px-4 py-8 sm:px-6">
        <Card variant="outlined">
          <CardHeader>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">
              Create account
            </h1>
          </CardHeader>
          <CardContent>
            <AuthForm mode="signup" next="/review" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add account state to NavBar**

Replace `components/NavBar.tsx` with:

```tsx
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface NavItem {
  href: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dictionary", label: "Dictionary" },
  { href: "/review", label: "Review" },
  { href: "/review-history", label: "History" },
  { href: "/words", label: "My Words" },
];

type CurrentUser = { id: number; email: string };

export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);

  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setMobileMenuOpen(false);
  }

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return;
        setUser(data?.user ?? null);
        setAuthLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setAuthLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setMobileMenuOpen(false);
    router.push("/login");
    router.refresh();
  };

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <nav className="mx-auto max-w-4xl px-4 sm:px-6" aria-label="Main">
        <div className="flex h-14 items-center justify-between md:h-16">
          <h1 className="text-lg font-bold text-blue-600 dark:text-blue-400 md:text-xl">
            <Link
              href="/"
              className="rounded-md transition-colors hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:hover:text-blue-300 dark:focus-visible:ring-offset-gray-800"
            >
              Vocleap
            </Link>
          </h1>

          <div className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                      : "text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-300 dark:hover:bg-gray-700/60 dark:hover:text-blue-400"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}

            {authLoaded && (
              <div className="ml-2 flex items-center gap-2 border-l border-gray-200 pl-3 dark:border-gray-700">
                {user ? (
                  <>
                    <span
                      className="max-w-[160px] truncate text-sm text-gray-600 dark:text-gray-300"
                      title={user.email}
                    >
                      {user.email}
                    </span>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="rounded-md px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-blue-600 dark:text-gray-300 dark:hover:bg-gray-700/60 dark:hover:text-blue-400"
                    >
                      Sign out
                    </button>
                  </>
                ) : (
                  <Link
                    href="/login"
                    className="rounded-md px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-blue-600 dark:text-gray-300 dark:hover:bg-gray-700/60 dark:hover:text-blue-400"
                  >
                    Sign in
                  </Link>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-navigation"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-gray-700 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-700 md:hidden"
          >
            <svg
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {mobileMenuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>

        <div
          id="mobile-navigation"
          className={`grid overflow-hidden transition-all duration-300 ease-out md:hidden ${
            mobileMenuOpen
              ? "visible grid-rows-[1fr] opacity-100"
              : "invisible grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="min-h-0">
            <div className="grid grid-cols-2 gap-2 pb-4 pt-1">
              {NAV_ITEMS.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex min-h-[44px] items-center justify-center rounded-lg px-3 py-3 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                        : "bg-gray-50 text-gray-700 hover:bg-gray-100 dark:bg-gray-700/50 dark:text-gray-200 dark:hover:bg-gray-700"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}

              {authLoaded && (
                <div className="col-span-2 mt-2 border-t border-gray-200 pt-3 dark:border-gray-700">
                  {user ? (
                    <div className="flex items-center justify-between gap-3">
                      <span
                        className="truncate text-sm text-gray-600 dark:text-gray-300"
                        title={user.email}
                      >
                        {user.email}
                      </span>
                      <button
                        type="button"
                        onClick={handleSignOut}
                        className="flex min-h-[44px] items-center rounded-lg px-3 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                      >
                        Sign out
                      </button>
                    </div>
                  ) : (
                    <Link
                      href="/login"
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex min-h-[44px] items-center justify-center rounded-lg bg-gray-50 px-3 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:bg-gray-700/50 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      Sign in
                    </Link>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>
    </header>
  );
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `bunx tsc --noEmit && bun run lint`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add components/AuthForm.tsx app/login app/signup components/NavBar.tsx
git commit -m "feat: add login and signup pages with account-aware navbar"
```

---

## Task 9: Guard protected pages with a route group

**Files:**
- Create: `app/(app)/layout.tsx`
- Move: `app/review`, `app/words`, `app/review-history`

- [ ] **Step 1: Move the pages**

Run:

```bash
mkdir -p "app/(app)"
git mv app/review "app/(app)/review"
git mv app/words "app/(app)/words"
git mv app/review-history "app/(app)/review-history"
```

Expected: `git status` shows renames only.

- [ ] **Step 2: Add the server guard layout**

Create `app/(app)/layout.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return <>{children}</>;
}
```

- [ ] **Step 3: Verify routing is unchanged**

Run:

```bash
bunx tsc --noEmit
```

Start the server and check redirects:

```bash
DB_PATH=/tmp/vocleap-auth.db bunx next dev -p 3001
```

In another shell:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3001/review
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/dictionary
```

Expected: `/review` responds `307` (or `308`) with `redirect_url` ending in `/login`; `/dictionary` responds `200`.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)"
git commit -m "feat: require auth for review, words, and history pages"
```

---

## Task 10: Scope the data operations by user

**Files:**
- Modify: `lib/db/operations.ts`

- [ ] **Step 1: Change `createWord`**

Replace `createWord` with:

```ts
export async function createWord(
  userId: number,
  word: Omit<Word, "id" | "createdAt" | "updatedAt">
): Promise<number> {
  const stmt = db.prepare(`
    INSERT INTO words (user_id, word, translation, definitions, examples, phonetic, audio_url, source_language, target_language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = await stmt.run(
    userId,
    word.word,
    word.translation,
    JSON.stringify(word.definitions),
    JSON.stringify(word.examples),
    word.phonetic || null,
    word.audioUrl || null,
    word.sourceLanguage,
    word.targetLanguage
  );
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 2: Scope the word lookups and listing**

Replace `getWordById`, `getWordByText`, `getAllWords`, `updateWord`, and `deleteWord` with:

```ts
export async function getWordById(
  userId: number,
  id: number
): Promise<Word | null> {
  const stmt = db.prepare("SELECT * FROM words WHERE id = ? AND user_id = ?");
  const r = toRow<WordRow>(await stmt.get(id, userId));
  return r ? wordFromRow(r) : null;
}

export async function getWordByText(
  userId: number,
  word: string
): Promise<Word | null> {
  const stmt = db.prepare("SELECT * FROM words WHERE word = ? AND user_id = ?");
  const r = toRow<WordRow>(await stmt.get(word, userId));
  return r ? wordFromRow(r) : null;
}

export async function getAllWords(
  userId: number,
  limit: number = 50,
  offset: number = 0
): Promise<{ words: Word[]; total: number }> {
  const countStmt = db.prepare("SELECT COUNT(*) as count FROM words WHERE user_id = ?");
  const totalRow = await countStmt.get(userId);
  const total = Number(totalRow?.count ?? 0);

  const stmt = db.prepare(
    "SELECT * FROM words WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
  );
  const rows = toRows<WordRow>(await stmt.all(userId, limit, offset));
  return {
    words: rows.map(wordFromRow),
    total,
  };
}

export async function updateWord(
  userId: number,
  id: number,
  updates: Partial<Word>
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.translation) {
    fields.push("translation = ?");
    values.push(updates.translation);
  }
  if (updates.definitions) {
    fields.push("definitions = ?");
    values.push(JSON.stringify(updates.definitions));
  }
  if (updates.examples) {
    fields.push("examples = ?");
    values.push(JSON.stringify(updates.examples));
  }
  if (updates.phonetic !== undefined) {
    fields.push("phonetic = ?");
    values.push(updates.phonetic);
  }
  if (updates.audioUrl !== undefined) {
    fields.push("audio_url = ?");
    values.push(updates.audioUrl);
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id, userId);

  const stmt = db.prepare(
    `UPDATE words SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`
  );
  const result = await stmt.run(...values);
  return result.changes > 0;
}

export async function deleteWord(
  userId: number,
  id: number
): Promise<boolean> {
  const stmt = db.prepare("DELETE FROM words WHERE id = ? AND user_id = ?");
  const result = await stmt.run(id, userId);
  return result.changes > 0;
}
```

- [ ] **Step 3: Add an ownership check**

Append after `deleteWord`:

```ts
export async function assertWordOwned(
  userId: number,
  wordId: number
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM words WHERE id = ? AND user_id = ?")
    .get(wordId, userId);
  return row !== null;
}
```

- [ ] **Step 4: Scope review reads**

Replace `getReview`, `getDueReviews`, `getNewWords`, `getReviewStats`, `getReviewHistory`, and `getAllReviewHistory` with:

```ts
export async function getReview(
  userId: number,
  wordId: number
): Promise<Review | null> {
  const stmt = db.prepare(`
    SELECT r.*
    FROM reviews r
    JOIN words w ON w.id = r.word_id
    WHERE r.word_id = ? AND w.user_id = ?
  `);
  const r = toRow<ReviewRow>(await stmt.get(wordId, userId));
  if (!r) return null;
  return {
    id: r.id,
    wordId: r.word_id,
    easeFactor: r.ease_factor,
    interval: r.interval,
    repetitions: r.repetitions,
    nextReviewDate: r.next_review_date,
    lastReviewed: r.last_reviewed ?? undefined,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
  };
}

export async function getDueReviews(
  userId: number,
  limit: number = 20
): Promise<(Review & { word: Word })[]> {
  const stmt = db.prepare(`
    SELECT r.*, w.word, w.translation, w.definitions, w.examples, w.phonetic, w.audio_url, w.source_language, w.target_language
    FROM reviews r
    JOIN words w ON r.word_id = w.id
    WHERE r.next_review_date <= datetime('now') AND w.user_id = ?
    ORDER BY r.next_review_date ASC
    LIMIT ?
  `);
  const rows = toRows<ReviewWithWordRow>(await stmt.all(userId, limit));
  return rows.map((r) => ({
    id: r.id,
    wordId: r.word_id,
    easeFactor: r.ease_factor,
    interval: r.interval,
    repetitions: r.repetitions,
    nextReviewDate: r.next_review_date,
    lastReviewed: r.last_reviewed ?? undefined,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
    word: {
      id: r.word_id,
      word: r.word,
      translation: r.translation,
      definitions: JSON.parse(String(r.definitions || "[]")),
      examples: JSON.parse(String(r.examples || "[]")),
      phonetic: r.phonetic ?? undefined,
      audioUrl: r.audio_url ?? undefined,
      sourceLanguage: r.source_language,
      targetLanguage: r.target_language,
    },
  }));
}

export async function getNewWords(
  userId: number,
  limit: number = 20
): Promise<Array<Review & { word: Word }>> {
  const stmt = db.prepare(`
    SELECT w.id as word_id, w.word, w.translation, w.definitions, w.examples, w.phonetic, w.audio_url, w.source_language, w.target_language, w.created_at, w.updated_at
    FROM words w
    LEFT JOIN reviews r ON w.id = r.word_id
    WHERE r.word_id IS NULL AND w.user_id = ?
    ORDER BY w.created_at DESC
    LIMIT ?
  `);
  const rows = toRows<NewWordRow>(await stmt.all(userId, limit));
  return rows.map((r) => ({
    id: r.word_id,
    wordId: r.word_id,
    easeFactor: 2.5,
    interval: 0,
    repetitions: 0,
    nextReviewDate: new Date().toISOString(),
    lastReviewed: undefined,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
    word: {
      id: r.word_id,
      word: r.word,
      translation: r.translation,
      definitions: JSON.parse(String(r.definitions || "[]")),
      examples: JSON.parse(String(r.examples || "[]")),
      phonetic: r.phonetic ?? undefined,
      audioUrl: r.audio_url ?? undefined,
      sourceLanguage: r.source_language,
      targetLanguage: r.target_language,
    },
  }));
}

export async function getReviewStats(userId: number): Promise<{
  due: number;
  total: number;
  newWords: number;
}> {
  const dueStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM reviews r
    JOIN words w ON w.id = r.word_id
    WHERE w.user_id = ? AND r.next_review_date <= datetime('now')
  `);
  const totalStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM reviews r
    JOIN words w ON w.id = r.word_id
    WHERE w.user_id = ?
  `);
  const newStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM words w
    LEFT JOIN reviews r ON w.id = r.word_id
    WHERE w.user_id = ? AND r.word_id IS NULL
  `);

  const dueRow = await dueStmt.get(userId);
  const totalRow = await totalStmt.get(userId);
  const newRow = await newStmt.get(userId);

  return {
    due: Number(dueRow?.count ?? 0),
    total: Number(totalRow?.count ?? 0),
    newWords: Number(newRow?.count ?? 0),
  };
}

export async function getReviewHistory(
  userId: number,
  wordId: number
): Promise<ReviewHistory[]> {
  const stmt = db.prepare(`
    SELECT rh.*
    FROM review_history rh
    JOIN words w ON w.id = rh.word_id
    WHERE rh.word_id = ? AND w.user_id = ?
    ORDER BY rh.reviewed_at DESC
  `);
  const rows = toRows<ReviewHistoryRow>(await stmt.all(wordId, userId));
  return rows.map((r) => ({
    id: r.id,
    wordId: r.word_id,
    rating: r.rating,
    previousEaseFactor: r.previous_ease_factor,
    previousInterval: r.previous_interval,
    previousRepetitions: r.previous_repetitions,
    newEaseFactor: r.new_ease_factor,
    newInterval: r.new_interval,
    newRepetitions: r.new_repetitions,
    reviewedAt: r.reviewed_at ?? undefined,
  }));
}

export async function getAllReviewHistory(
  userId: number
): Promise<Array<ReviewHistory & { word: string; translation: string }>> {
  const stmt = db.prepare(`
    SELECT rh.*, w.word, w.translation
    FROM review_history rh
    JOIN words w ON rh.word_id = w.id
    WHERE w.user_id = ?
    ORDER BY rh.reviewed_at DESC
  `);
  const rows = toRows<ReviewHistoryWithWordRow>(await stmt.all(userId));
  return rows.map((r) => ({
    id: r.id,
    wordId: r.word_id,
    rating: r.rating,
    previousEaseFactor: r.previous_ease_factor,
    previousInterval: r.previous_interval,
    previousRepetitions: r.previous_repetitions,
    newEaseFactor: r.new_ease_factor,
    newInterval: r.new_interval,
    newRepetitions: r.new_repetitions,
    reviewedAt: r.reviewed_at ?? undefined,
    word: r.word,
    translation: r.translation,
  }));
}
```

Leave `createOrUpdateReview` and `addReviewHistory` unchanged.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`

Expected: errors only in the route files that still call the old signatures. Those are fixed in Tasks 11 and 12.

- [ ] **Step 6: Commit**

```bash
git add lib/db/operations.ts
git commit -m "feat: scope word and review operations by user"
```

---

## Task 11: Require auth and scope the words API

**Files:**
- Modify: `app/api/words/route.ts`

- [ ] **Step 1: Add the guard import and rewire GET**

Replace the import block and `GET` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  createWord,
  getWordById,
  getWordByText,
  getAllWords,
  updateWord,
  deleteWord,
  Word,
  createOrUpdateReview,
} from "@/lib/db/operations";
import { withUser } from "@/lib/auth/guard";

export async function GET(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { searchParams } = new URL(request.url);
      const id = searchParams.get("id");
      const word = searchParams.get("word");

      if (id) {
        const w = await getWordById(user.id, parseInt(id, 10));
        if (!w) {
          return NextResponse.json({ error: "Word not found" }, { status: 404 });
        }
        return NextResponse.json(w);
      }

      if (word) {
        const w = await getWordByText(user.id, word);
        if (!w) {
          return NextResponse.json({ error: "Word not found" }, { status: 404 });
        }
        return NextResponse.json(w);
      }

      const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
      const offset = parseInt(searchParams.get("offset") || "0");
      const { words, total } = await getAllWords(user.id, limit, offset);

      return NextResponse.json({
        words,
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      });
    } catch (error) {
      console.error("Get words error:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
```

- [ ] **Step 2: Rewire POST**

Replace `POST` with:

```ts
export async function POST(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const body = await request.json();

      // Batch import: array of word entries
      if (Array.isArray(body)) {
        const results: Array<{ word: string; success: boolean; id?: number; error?: string }> = [];

        for (const entry of body) {
          const { word, translation, definitions, examples, phonetic, audioUrl, sourceLanguage, targetLanguage } = entry;

          if (!word || !translation) {
            results.push({ word: word || "", success: false, error: "Word and translation are required" });
            continue;
          }

          const existing = await getWordByText(user.id, word);
          if (existing) {
            results.push({ word, success: false, error: "Word already exists", id: existing.id });
            continue;
          }

          const wordData: Omit<Word, "id" | "createdAt" | "updatedAt"> = {
            word: word.trim(),
            translation,
            definitions: definitions || [],
            examples: examples || [],
            phonetic: phonetic || "",
            audioUrl: audioUrl || "",
            sourceLanguage: sourceLanguage || "en",
            targetLanguage: targetLanguage || "zh-CN",
          };

          try {
            const id = await createWord(user.id, wordData);
            const newWord = await getWordById(user.id, id);
            if (!newWord) {
              throw new Error("Created word could not be loaded");
            }

            await createOrUpdateReview({
              wordId: id,
              easeFactor: 2.5,
              interval: 0,
              repetitions: 0,
              nextReviewDate: new Date().toISOString().split("T")[0],
            });

            results.push({ word, success: true, id: newWord.id });
          } catch (err) {
            results.push({ word, success: false, error: err instanceof Error ? err.message : "Failed to create word" });
          }
        }

        const imported = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return NextResponse.json({
          imported,
          failed,
          total: results.length,
          results,
        }, { status: 201 });
      }

      // Single word import
      const { word, translation, definitions, examples, phonetic, audioUrl, sourceLanguage, targetLanguage } = body;

      if (!word || !translation) {
        return NextResponse.json(
          { error: "Word and translation are required" },
          { status: 400 }
        );
      }

      const existing = await getWordByText(user.id, word);
      if (existing) {
        return NextResponse.json(
          { error: "Word already exists", word: existing },
          { status: 409 }
        );
      }

      const wordData: Omit<Word, "id" | "createdAt" | "updatedAt"> = {
        word: word.trim(),
        translation,
        definitions: definitions || [],
        examples: examples || [],
        phonetic: phonetic || "",
        audioUrl: audioUrl || "",
        sourceLanguage: sourceLanguage || "en",
        targetLanguage: targetLanguage || "zh-CN",
      };

      const id = await createWord(user.id, wordData);
      const newWord = await getWordById(user.id, id);

      await createOrUpdateReview({
        wordId: id,
        easeFactor: 2.5,
        interval: 0,
        repetitions: 0,
        nextReviewDate: new Date().toISOString().split("T")[0],
      });

      return NextResponse.json(newWord, { status: 201 });
    } catch (error) {
      console.error("Create word error:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
```

- [ ] **Step 3: Rewire PUT and DELETE**

Replace `PUT` and `DELETE` with:

```ts
export async function PUT(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const body = await request.json();
      const { id, ...updates } = body;

      if (!id) {
        return NextResponse.json(
          { error: "Word ID is required" },
          { status: 400 }
        );
      }

      const success = await updateWord(user.id, Number(id), updates);
      if (!success) {
        return NextResponse.json({ error: "Word not found" }, { status: 404 });
      }

      const updated = await getWordById(user.id, Number(id));
      return NextResponse.json(updated);
    } catch (error) {
      console.error("Update word error:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}

export async function DELETE(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { searchParams } = new URL(request.url);
      const id = searchParams.get("id");

      if (!id) {
        return NextResponse.json(
          { error: "Word ID is required" },
          { status: 400 }
        );
      }

      const success = await deleteWord(user.id, parseInt(id, 10));
      if (!success) {
        return NextResponse.json({ error: "Word not found" }, { status: 404 });
      }

      return NextResponse.json({ success: true });
    } catch (error) {
      console.error("Delete word error:", error);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`

Expected: errors only in `app/api/reviews/route.ts`.

- [ ] **Step 5: Commit**

```bash
git add app/api/words/route.ts
git commit -m "feat: require auth and scope the words api by user"
```

---

## Task 12: Require auth and scope the reviews API

**Files:**
- Modify: `app/api/reviews/route.ts`

- [ ] **Step 1: Rewire GET**

Replace the import list and `GET` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  getDueReviews, getReview, createOrUpdateReview, addReviewHistory,
  getReviewStats, getReviewHistory, getAllReviewHistory, Review, getNewWords,
  assertWordOwned,
} from "@/lib/db/operations";
import { sm2Algorithm, parseRating, getInitialSM2State, formatDateForDB } from "@/lib/srs/sm2";
import { withUser } from "@/lib/auth/guard";

export async function GET(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { searchParams } = new URL(request.url);
      const action = searchParams.get("action");
      const wordId = searchParams.get("wordId");

      if (action === "due" || action === "review") {
        return NextResponse.json(
          await getDueReviews(
            user.id,
            parseInt(searchParams.get("limit") || "20", 10)
          )
        );
      }
      if (action === "new") {
        return NextResponse.json(
          await getNewWords(
            user.id,
            parseInt(searchParams.get("limit") || "20", 10)
          )
        );
      }
      if (action === "stats") {
        return NextResponse.json(await getReviewStats(user.id));
      }
      if (action === "history" && wordId) {
        return NextResponse.json(
          await getReviewHistory(user.id, parseInt(wordId, 10))
        );
      }
      if (action === "history") {
        return NextResponse.json(await getAllReviewHistory(user.id));
      }
      if (wordId) {
        const review = await getReview(user.id, parseInt(wordId, 10));
        if (!review) return NextResponse.json({ error: "Not found" }, { status: 404 });
        return NextResponse.json(review);
      }
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    } catch (e) {
      console.error("GET reviews error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
```

- [ ] **Step 2: Rewire POST with an ownership check**

Replace `POST` with:

```ts
export async function POST(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { wordId, rating } = await request.json();
      if (!wordId || rating === undefined) {
        return NextResponse.json({ error: "Word ID and rating required" }, { status: 400 });
      }

      const numericWordId = Number(wordId);
      if (!(await assertWordOwned(user.id, numericWordId))) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      const numericRating = typeof rating === "string" ? parseRating(rating as "again" | "hard" | "good" | "easy") : rating;
      if (numericRating < 0 || numericRating > 5) {
        return NextResponse.json({ error: "Rating must be 0-5" }, { status: 400 });
      }

      const review: Review | null = await getReview(user.id, numericWordId);
      const prevState = review ? {
        easeFactor: review.easeFactor,
        interval: review.interval,
        repetitions: review.repetitions,
      } : { easeFactor: 2.5, interval: 0, repetitions: 0 };

      const inputReview = review || {
        id: 0, wordId: numericWordId, easeFactor: 2.5, interval: 0, repetitions: 0,
        nextReviewDate: new Date().toISOString(), lastReviewed: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };

      const result = sm2Algorithm({
        easeFactor: inputReview.easeFactor,
        interval: inputReview.interval,
        repetitions: inputReview.repetitions,
        rating: numericRating,
      });

      await createOrUpdateReview({
        wordId: numericWordId,
        easeFactor: result.easeFactor,
        interval: result.interval,
        repetitions: result.repetitions,
        nextReviewDate: formatDateForDB(result.nextReviewDate),
        lastReviewed: formatDateForDB(new Date()),
      });

      await addReviewHistory({
        wordId: numericWordId,
        rating: numericRating,
        previousEaseFactor: prevState.easeFactor,
        previousInterval: prevState.interval,
        previousRepetitions: prevState.repetitions,
        newEaseFactor: result.easeFactor,
        newInterval: result.interval,
        newRepetitions: result.repetitions,
      });

      return NextResponse.json({
        wordId: numericWordId,
        easeFactor: result.easeFactor,
        interval: result.interval,
        repetitions: result.repetitions,
        nextReviewDate: formatDateForDB(result.nextReviewDate),
      });
    } catch (e) {
      console.error("POST reviews error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/reviews/route.ts
git commit -m "feat: require auth and scope the reviews api by user"
```

---

## Task 13: Add the signed-out save message in the dictionary

**Files:**
- Modify: `components/DictionaryLookup.tsx`

- [ ] **Step 1: Add the Link import and auth state**

At the top of `components/DictionaryLookup.tsx`, add:

```tsx
import Link from "next/link";
```

Next to the existing `saveMessage` state, add:

```tsx
  const [saveRequiresAuth, setSaveRequiresAuth] = useState(false);
```

- [ ] **Step 2: Reset the flag on lookup and save**

In `lookupWord`, after `setSaveMessage("")`, add:

```tsx
        setSaveRequiresAuth(false);
```

In `handleSave`, after `setSaveMessage("")`, add:

```tsx
    setSaveRequiresAuth(false);
```

- [ ] **Step 3: Handle 401 in `handleSave`**

Replace the `if (!response.ok)` block with:

```tsx
      if (!response.ok) {
        if (response.status === 401) {
          setSaveRequiresAuth(true);
          setSaveMessage("");
        } else if (response.status === 409) {
          setSaveMessage("Word already saved!");
        } else {
          throw new Error(data.error || "Save failed");
        }
      } else {
        setSaveMessage("Word saved successfully!");
      }
```

- [ ] **Step 4: Render the sign-in link**

After the existing `saveMessage` paragraph, add:

```tsx
              {saveRequiresAuth && (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  <Link
                    href="/login?next=/dictionary"
                    className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Sign in
                  </Link>{" "}
                  to save this word.
                </p>
              )}
```

- [ ] **Step 5: Verify with a signed-out session**

Run the server and check the rendered page has no errors:

```bash
bunx tsc --noEmit && bun run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add components/DictionaryLookup.tsx
git commit -m "feat: prompt signed-out users to sign in before saving"
```

---

## Task 14: Write the end-to-end auth suite

**Files:**
- Create: `tests/e2e/auth.spec.ts`

- [ ] **Step 1: Write the suite**

Create `tests/e2e/auth.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";

test.describe.configure({ mode: "serial" });

const PASSWORD = "test-password-123";
const OWNER_EMAIL = "owner@test.local";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function signUp(page: Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByText(email)).toBeVisible();
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/review$/);
}

test("owner claims existing words on the first signup", async ({ page }) => {
  // Hit an endpoint that imports the DB module and awaits schema creation.
  await page.request.get("/api/auth/me");

  const legacyWord = `legacy-${Date.now()}`;
  const db = new Database("./data/test.db");
  try {
    db.prepare("INSERT INTO words (word, translation) VALUES (?, ?)").run(
      legacyWord,
      "legacy translation"
    );
  } finally {
    db.close();
  }

  await signUp(page, OWNER_EMAIL);

  const response = await page.request.get(
    `/api/words?word=${encodeURIComponent(legacyWord)}`
  );
  expect(response.status()).toBe(200);
  expect((await response.json()).user_id).toBeTruthy();
});

test("logout clears access and protected pages redirect", async ({ page }) => {
  const email = uniqueEmail("logout");
  await signUp(page, email);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/words");
  await expect(page).toHaveURL(/\/login$/);
});

test("login restores access", async ({ page }) => {
  const email = uniqueEmail("login");
  await signUp(page, email);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await signIn(page, email);
  await expect(page.getByText(email)).toBeVisible();
});

test("wrong password shows a generic error", async ({ page }) => {
  const email = uniqueEmail("wrongpass");
  await signUp(page, email);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toHaveText("Invalid email or password");
  await expect(page).toHaveURL(/\/login$/);
});

test("two devices for the same user share words", async ({ browser }) => {
  const email = uniqueEmail("sync");
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
  const pageA = await deviceA.newPage();
  const pageB = await deviceB.newPage();

  try {
    await signUp(pageA, email);
    await signIn(pageB, email);

    const created = await pageA.request.post("/api/words", {
      data: { word: "banana", translation: "香蕉" },
    });
    expect(created.status()).toBe(201);

    await pageB.goto("/words");
    await expect(pageB.getByText("banana")).toBeVisible();
  } finally {
    await deviceA.close();
    await deviceB.close();
  }
});

test("users cannot see or fetch each other's words", async ({ browser }) => {
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
  const pageA = await deviceA.newPage();
  const pageB = await deviceB.newPage();

  try {
    await signUp(pageA, uniqueEmail("alice"));
    await signUp(pageB, uniqueEmail("bob"));

    const created = await pageA.request.post("/api/words", {
      data: { word: "apple", translation: "蘋果" },
    });
    expect(created.status()).toBe(201);
    const word = await created.json();

    await pageB.goto("/words");
    await expect(pageB.getByText("No words saved yet")).toBeVisible();

    const forbidden = await pageB.request.get(`/api/words?id=${word.id}`);
    expect(forbidden.status()).toBe(404);

    const reviewDenied = await pageB.request.post("/api/reviews", {
      data: { wordId: word.id, rating: "good" },
    });
    expect(reviewDenied.status()).toBe(404);
  } finally {
    await deviceA.close();
    await deviceB.close();
  }
});
```

- [ ] **Step 2: Run the auth suite**

Run: `bunx playwright test tests/e2e/auth.spec.ts --project=chromium`

Expected: 6 passed. The first test must run first; serial mode preserves file order.

- [ ] **Step 3: Run the whole suite**

Run: `bunx playwright test --project=chromium`

Expected: 8 passed.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/auth.spec.ts
git commit -m "test: cover signup, login, owner claim, and user isolation"
```

---

## Task 15: Add the manual owner claim script and documentation

**Files:**
- Create: `scripts/claim-owner.ts`
- Create: `.env.example`
- Modify: `app/page.tsx`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the manual claim script**

Create `scripts/claim-owner.ts`:

```ts
import { db, initDatabase } from "../lib/db/init.ts";

async function main() {
  const email = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--email="))
    ?.slice("--email=".length)
    .trim()
    .toLowerCase();

  if (!email) {
    console.error("Usage: bun run claim-owner --email=you@example.com");
    process.exit(1);
  }

  await initDatabase();

  const user = await db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) {
    console.error(`No user with email ${email}. Sign up first.`);
    process.exit(1);
  }

  const result = await db
    .prepare("UPDATE words SET user_id = ? WHERE user_id IS NULL")
    .run(Number(user.id));

  console.log(`Claimed ${result.changes} words for ${email}.`);
}

main().catch((error) => {
  console.error("Claim failed:", error);
  process.exit(1);
});
```

- [ ] **Step 2: Add `.env.example`**

Create `.env.example`:

```bash
# local | turso
DB_MODE=local

# Local SQLite path (DB_MODE=local)
DB_PATH=./data/vocleap.db

# Turso (DB_MODE=turso)
# TURSO_URL=libsql://your-db.turso.io
# TURSO_AUTH_TOKEN=

# First account with this email claims all pre-multi-user words.
# Set this before deploying and sign up first.
OWNER_EMAIL=you@example.com
```

- [ ] **Step 3: Update the home page copy**

In `app/page.tsx`, replace:

```tsx
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            Works offline as a PWA • Data stored locally with SQLite
          </p>
```

with:

```tsx
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            Works offline as a PWA • Your vocabulary syncs across devices
          </p>

          <div className="mt-6 flex items-center justify-center gap-3">
            <Link
              href="/signup"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Create account
            </Link>
            <Link
              href="/login"
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Sign in
            </Link>
          </div>
```

- [ ] **Step 4: Document auth, migration, and recovery in README**

Append to `README.md`:

```markdown
## Accounts and multi-user data

Vocleap uses email + password accounts. Each user has a private vocabulary;
words, reviews, and review history are isolated by `words.user_id`.

- Sign up at `/signup`, sign in at `/login`.
- `GET/POST/PUT/DELETE /api/words` and `/api/reviews` require a session.
- `/review`, `/words`, and `/review-history` redirect to `/login` when signed out.
- `/dictionary` is public; saving a word requires an account.

### Environment

Copy `.env.example` to `.env.local` and set:

- `DB_MODE` (`local` or `turso`)
- `OWNER_EMAIL` — the email that should own all pre-multi-user words

### Upgrading an existing database

The `words` table must be rebuilt to allow the same word for different users.
Run once per database, before deploying the new code:

```bash
# local
DB_PATH=./data/vocleap.db bun run migrate:multiuser

# turso
DB_MODE=turso TURSO_URL=... TURSO_AUTH_TOKEN=... bun run migrate:multiuser
```

The script runs under Node (it loads `better-sqlite3`, which crashes the Bun
1.3 runtime), so Node 23.6+ is required. The npm script already invokes `node`.

The script is idempotent. Back up the database first. For Turso, test on a
branch before production.

### First signup claims existing words

If `OWNER_EMAIL` is set and the account being created is the **first** account,
all words with `user_id IS NULL` are assigned to it. Sign up with that email
immediately after deploying.

If someone else registers first, the automatic claim is disabled. Recover with:

```bash
bun run claim-owner --email=you@example.com
```

### Reset a forgotten password (manual)

There is no password reset flow yet. Generate a new hash and update the row:

```bash
bun -e 'const { hashPassword } = await import("./lib/auth/password.ts"); console.log(await hashPassword("new-password"))'
sqlite3 data/vocleap.db "UPDATE users SET password_hash = '<paste hash>' WHERE email = '<your email>';"
```

For Turso, run the equivalent `UPDATE` in the Turso shell.
```

- [ ] **Step 5: Add the CHANGELOG entry**

Prepend to `CHANGELOG.md`:

```markdown
## [2026-11-03] Multi-user Accounts
- Added email + password accounts with server-side sessions (`users`, `sessions`); passwords use Node scrypt, session cookies are HttpOnly/SameSite=Lax and stored as SHA-256 hashes
- Added `/login`, `/signup`, `/api/auth/{signup,login,logout,me}`; NavBar shows the signed-in email and a sign-out action
- `words` now belongs to a user (`words.user_id`, `UNIQUE(user_id, word)`); `reviews` and `review_history` are isolated through a `words` join
- `/review`, `/words`, `/review-history` and the words/reviews APIs require a session; `/dictionary` stays public and prompts sign-in on save
- Added `bun run migrate:multiuser` (idempotent, local + Turso, rebuilds `words` atomically without disabling foreign keys) and `bun run claim-owner` for manual recovery
- The first account with `OWNER_EMAIL` claims all pre-existing words and review history
- Playwright now runs on its own port and test database; added auth/isolation E2E coverage and fixed the stale dictionary spec
```

- [ ] **Step 6: Run full verification**

Run:

```bash
bunx tsc --noEmit
bun run lint
bunx playwright test --project=chromium
```

Expected: typecheck clean, lint clean, 8 tests passed.

- [ ] **Step 7: Commit**

```bash
git add scripts/claim-owner.ts .env.example app/page.tsx README.md CHANGELOG.md
git commit -m "docs: document auth, migration, and owner recovery"
```

---

## Task 16: Final manual verification on a migrated database

- [ ] **Step 1: Migrate a copy of the real local database**

Run:

```bash
cp data/vocleap.db /tmp/vocleap-verify.db
cp data/vocleap.db-wal /tmp/vocleap-verify.db-wal 2>/dev/null || true
cp data/vocleap.db-shm /tmp/vocleap-verify.db-shm 2>/dev/null || true
DB_PATH=/tmp/vocleap-verify.db bun run migrate:multiuser
sqlite3 /tmp/vocleap-verify.db "SELECT COUNT(*) FROM words;"
sqlite3 /tmp/vocleap-verify.db "SELECT COUNT(*) FROM reviews;"
```

Expected: migration succeeds; both counts match the pre-migration values.

- [ ] **Step 2: Sign up as the owner and verify the claim**

Run the app against the copy with your real owner email:

```bash
DB_PATH=/tmp/vocleap-verify.db OWNER_EMAIL=you@example.com bunx next dev -p 3001
```

In a browser:

1. Open `http://localhost:3001/signup`, register `you@example.com`.
2. Expect redirect to `/review`.
3. Open `/words` and confirm the expected word count.
4. Open `/review-history` and confirm history is present.

- [ ] **Step 3: Confirm a second user is isolated**

Register a second account in a private window and confirm `/words` is empty.

- [ ] **Step 4: Note the follow-up**

Cross-device review cursor sync remains stage 2 and needs its own spec. The
existing `localStorage` cursor is untouched by this plan.

---

## Notes for the implementer

- `cookies()` is async in this Next version. Never call `cookieStore.set()` during
  a Server Component render; only Route Handlers and Server Functions.
- `middleware.ts` is deprecated in this Next version; the convention is
  `proxy.ts`. This plan deliberately does not use it for auth because proxy code
  should not query the database.
- `searchParams` is a Promise in pages. Keep the existing pattern from
  `app/dictionary/page.tsx`.
- Do not run the migration automatically in `initDatabase()`; it is an explicit
  deployment step.
- The scripts must run under Node, not Bun: Bun 1.3 crashes when loading the
  `better-sqlite3` native addon. Their relative imports therefore use explicit
  `.ts` extensions, which is why `allowImportingTsExtensions` is enabled.
- If `bunx next dev -p 3001` is already running when tests start, Playwright is
  configured with `reuseExistingServer: false` and will fail on the occupied
  port. Stop the manual server first.
```
