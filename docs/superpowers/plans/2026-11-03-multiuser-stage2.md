# Stage 2: Cross-Device Review Cursor Sync - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist `/review` progress (current card index, session stats, queue order) server-side per `(user_id, device_id, queue_type)` so it syncs across devices.

**Architecture:** Server-first with localStorage fallback. Client reads `deviceId` from localStorage (generates if missing), fetches server state on mount, merges with local state using `updated_at` timestamp (last-write-wins), then writes through to both localStorage and server on every rating. Debounced POST (≤1/500ms) to `/api/review-state`.

**Tech Stack:** Next.js 16 (App Router), SQLite (better-sqlite3 + libsql/Turso), React 19, Playwright for E2E

---

## Files to Create / Modify

| File | Action |
|------|--------|
| `lib/db/init.ts` | Add `review_sessions` table to `createSchema()` |
| `scripts/migrate-multiuser.ts` | Add `review_sessions` to `REBUILD_STATEMENTS` |
| `lib/db/operations.ts` | Add `getReviewSession`, `upsertReviewSession` |
| `app/api/review-state/route.ts` | **Create** GET + POST handlers (wrapped in `withUser`) |
| `components/ReviewSession.tsx` | Integrate server sync (localStorage ↔ API) |
| `tests/e2e/review-sync.spec.ts` | **Create** E2E test for cross-device sync |

---

### Task 1: Add `review_sessions` table to schema and migration

**Files:**
- Modify: `lib/db/init.ts` (createSchema function)
- Modify: `scripts/migrate-multiuser.ts` (REBUILD_STATEMENTS)

- [ ] **Step 1: Add `review_sessions` to `createSchema()` in `lib/db/init.ts`**

```typescript
// In createSchema(), after review_history table creation (~line 240), add:

await db.exec(`
  CREATE TABLE IF NOT EXISTS review_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    queue_type TEXT NOT NULL CHECK (queue_type IN ('due','new')),
    queue_word_ids TEXT NOT NULL,
    current_index INTEGER NOT NULL DEFAULT 0,
    stats_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, device_id, queue_type)
  )
`);

await db.exec(`CREATE INDEX IF NOT EXISTS idx_review_sessions_user ON review_sessions(user_id)`);
```

- [ ] **Step 2: Add to `REBUILD_STATEMENTS` in `scripts/migrate-multiuser.ts`**

```typescript
// Add to REBUILD_STATEMENTS array (after review_history statements, before DROP statements):

`CREATE TABLE review_sessions_migrated (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  queue_type TEXT NOT NULL CHECK (queue_type IN ('due','new')),
  queue_word_ids TEXT NOT NULL,
  current_index INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, device_id, queue_type)
)`,

`CREATE INDEX IF NOT EXISTS idx_review_sessions_user ON review_sessions_migrated(user_id)`,
```

- [ ] **Step 3: Run migration locally to verify**

```bash
DB_MODE=local DB_PATH=/tmp/stage2-test.db bun run migrate:multiuser
sqlite3 /tmp/stage2-test.db ".schema review_sessions"
```

Expected: table exists with correct columns, unique constraint, index.

- [ ] **Step 4: TypeScript check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add lib/db/init.ts scripts/migrate-multiuser.ts
git commit -m "feat: add review_sessions table for cross-device sync"
```

---

### Task 2: Database operations for review sessions

**Files:**
- Modify: `lib/db/operations.ts`

- [ ] **Step 1: Add types and operations**

```typescript
// Add near other interfaces (around line 30)

export interface ReviewSession {
  id?: number;
  userId: number;
  deviceId: string;
  queueType: "due" | "new";
  queueWordIds: number[];
  currentIndex: number;
  stats: {
    reviewed: number;
    again: number;
    hard: number;
    good: number;
    easy: number;
  };
  updatedAt?: string;
}

interface ReviewSessionRow {
  id: number;
  user_id: number;
  device_id: string;
  queue_type: "due" | "new";
  queue_word_ids: string;
  current_index: number;
  stats_json: string;
  updated_at: string | null;
}
```

- [ ] **Step 2: Add `getReviewSession` function**

```typescript
export async function getReviewSession(
  userId: number,
  deviceId: string,
  queueType: "due" | "new"
): Promise<ReviewSession | null> {
  const stmt = db.prepare(`
    SELECT * FROM review_sessions
    WHERE user_id = ? AND device_id = ? AND queue_type = ?
  `);
  const row = await stmt.get(userId, deviceId, queueType);
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    queueType: row.queue_type,
    queueWordIds: JSON.parse(row.queue_word_ids),
    currentIndex: row.current_index,
    stats: JSON.parse(row.stats_json),
    updatedAt: row.updated_at ?? undefined,
  };
}
```

- [ ] **Step 3: Add `upsertReviewSession` function**

```typescript
export async function upsertReviewSession(
  session: Omit<ReviewSession, "id" | "updatedAt">
): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO review_sessions (user_id, device_id, queue_type, queue_word_ids, current_index, stats_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, queue_type) DO UPDATE SET
      queue_word_ids = excluded.queue_word_ids,
      current_index = excluded.current_index,
      stats_json = excluded.stats_json,
      updated_at = CURRENT_TIMESTAMP
  `);
  await stmt.run(
    session.userId,
    session.deviceId,
    session.queueType,
    JSON.stringify(session.queueWordIds),
    session.currentIndex,
    JSON.stringify(session.stats)
  );
}
```

- [ ] **Step 4: TypeScript check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add lib/db/operations.ts
git commit -m "feat: add get/upsert review session operations"
```

---

### Task 3: API route `/api/review-state`

**Files:**
- Create: `app/api/review-state/route.ts`

- [ ] **Step 1: Create the route file**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getReviewSession, upsertReviewSession } from "@/lib/db/operations";
import { withUser } from "@/lib/auth/guard";

export async function GET(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { searchParams } = new URL(request.url);
      const queue = searchParams.get("queue");
      const deviceId = searchParams.get("deviceId");

      if (!queue || !["due", "new"].includes(queue)) {
        return NextResponse.json({ error: "queue must be 'due' or 'new'" }, { status: 400 });
      }
      if (!deviceId) {
        return NextResponse.json({ error: "deviceId required" }, { status: 400 });
      }

      const session = await getReviewSession(user.id, deviceId, queue as "due" | "new");
      if (!session) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      return NextResponse.json({
        deviceId: session.deviceId,
        queueType: session.queueType,
        queueWordIds: session.queueWordIds,
        currentIndex: session.currentIndex,
        stats: session.stats,
        updatedAt: session.updatedAt,
      });
    } catch (e) {
      console.error("GET review-state error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}

export async function POST(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const body = await request.json();

      const { deviceId, queueType, queueWordIds, currentIndex, stats } = body;

      if (!deviceId || !queueType || !Array.isArray(queueWordIds) || typeof currentIndex !== "number" || !stats) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
      }
      if (!["due", "new"].includes(queueType)) {
        return NextResponse.json({ error: "queueType must be 'due' or 'new'" }, { status: 400 });
      }

      await upsertReviewSession({
        userId: user.id,
        deviceId,
        queueType,
        queueWordIds,
        currentIndex,
        stats,
      });

      return NextResponse.json({ ok: true, updatedAt: new Date().toISOString() });
    } catch (e) {
      console.error("POST review-state error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
```

- [ ] **Step 2: TypeScript check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add app/api/review-state/route.ts
git commit -m "feat: add /api/review-state GET/POST endpoints"
```

---

### Task 4: Integrate server sync into `ReviewSession.tsx`

**Files:**
- Modify: `components/ReviewSession.tsx`

- [ ] **Step 1: Add deviceId generation/storage**

```typescript
// Near top of component, after imports

function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return "";
  let deviceId = localStorage.getItem("vocleap_device_id");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem("vocleap_device_id", deviceId);
  }
  return deviceId;
}
```

- [ ] **Step 2: Add sync state and fetch logic**

```typescript
// Inside ReviewSession component, add state:

const [deviceId] = useState(() => getOrCreateDeviceId());
const [synced, setSynced] = useState(false);
const [syncQueue, setSyncQueue] = useState<Record<string, NodeJS.Timeout>>({});

// Load from server on mount
useEffect(() => {
  if (!deviceId) return;
  let cancelled = false;

  async function load() {
    try {
      const [dueRes, newRes] = await Promise.all([
        fetch(`/api/review-state?queue=due&deviceId=${deviceId}`),
        fetch(`/api/review-state?queue=new&deviceId=${deviceId}`),
      ]);

      if (cancelled) return;

      if (dueRes.ok) {
        const dueData = await dueRes.json();
        // Merge with localStorage: server wins if newer
        const localDue = JSON.parse(localStorage.getItem("review_due_state") || "{}");
        if (!localDue.updatedAt || (dueData.updatedAt && dueData.updatedAt > localDue.updatedAt)) {
          localStorage.setItem("review_due_state", JSON.stringify(dueData));
        }
      }
      if (newRes.ok) {
        const newData = await newRes.json();
        const localNew = JSON.parse(localStorage.getItem("review_new_state") || "{}");
        if (!localNew.updatedAt || (newData.updatedAt && newData.updatedAt > localNew.updatedAt)) {
          localStorage.setItem("review_new_state", JSON.stringify(newData));
        }
      }

      // Re-initialize queue from merged state
      initializeQueueFromStorage();
      setSynced(true);
    } catch (e) {
      console.error("Sync load failed:", e);
      setSynced(true); // Proceed with localStorage only
    }
  }

  load();
  return () => { cancelled = true; };
}, [deviceId]);
```

- [ ] **Step 3: Add debounced push to server**

```typescript
// Debounced save function
const saveToServer = useCallback(
  (queueType: "due" | "new", state: any) => {
    if (!deviceId || !synced) return;

    const existing = syncQueue.current[queueType];
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(async () => {
      try {
        await fetch("/api/review-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId,
            queueType,
            queueWordIds: state.queueWordIds,
            currentIndex: state.currentIndex,
            stats: state.stats,
          }),
        });
        // Update local updatedAt on success
        const local = JSON.parse(localStorage.getItem(`review_${queueType}_state`) || "{}");
        local.updatedAt = new Date().toISOString();
        localStorage.setItem(`review_${queueType}_state`, JSON.stringify(local));
      } catch (e) {
        console.error("Sync save failed:", e);
      }
    }, 500);

    setSyncQueue((prev) => ({ ...prev, [queueType]: timeout }));
  },
  [deviceId, synced]
);

// Call saveToServer after every rating in handleRate()
// Also call when queue switches (Due ↔ New)
```

- [ ] **Step 4: Initialize queue from merged localStorage**

```typescript
// Replace existing localStorage-only initialization with:

function initializeQueueFromStorage() {
  const storageKey = currentQueue === "due" ? "review_due_state" : "review_new_state";
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.queueWordIds && parsed.queueWordIds.length > 0) {
        setQueue(parsed.queueWordIds);
        setCurrentIndex(parsed.currentIndex || 0);
        setStats(parsed.stats || { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
      }
    } catch {
      // Ignore corrupt localStorage
    }
  }
}
```

- [ ] **Step 5: Update localStorage on every state change (existing + new)**

```typescript
// In handleRate() and queue switch, after updating local state:
localStorage.setItem(storageKey, JSON.stringify({
  queueWordIds: queue,
  currentIndex: newIndex,
  stats: newStats,
  updatedAt: new Date().toISOString(),
}));
saveToServer(currentQueue, { queueWordIds: queue, currentIndex: newIndex, stats: newStats });
```

- [ ] **Step 6: TypeScript check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add components/ReviewSession.tsx
git commit -m "feat: integrate server sync for review progress"
```

---

### Task 5: E2E test for cross-device sync

**Files:**
- Create: `tests/e2e/review-sync.spec.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { test, expect } from "@playwright/test";

const PASSWORD = "password123";

function uniqueEmail(prefix: string): string {
  return `${prefix}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/review$/);
}

async function addWordsViaAPI(page: import("@playwright/test").Page, words: Array<{word: string, translation: string}>) {
  const res = await page.request.post("/api/words", {
    data: words.map(w => ({ ...w, sourceLanguage: "en", targetLanguage: "zh-CN" }))
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test.describe("Review cross-device sync", () => {
  test("progress syncs from device A to device B", async ({ browser }) => {
    const email = uniqueEmail("sync");

    // --- Device A: sign up, add words, start review ---
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signUp(pageA, email);

    // Add 3 words so we have a due queue
    const words = [
      { word: "apple", translation: "蘋果" },
      { word: "banana", translation: "香蕉" },
      { word: "cat", translation: "貓" },
    ];
    await addWordsViaAPI(pageA, words);

    await pageA.goto("/review");
    await expect(pageA.getByText("Card 1 of 3")).toBeVisible();

    // Rate "Good" on first card
    await pageA.getByRole("button", { name: /Good/ }).click();
    await expect(pageA.getByText("Card 2 of 3")).toBeVisible();

    // Give it a moment to sync
    await pageA.waitForTimeout(1000);

    // --- Device B: new browser context (simulates different device) ---
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    // Sign in with same account
    await pageB.goto("/login");
    await pageB.getByLabel("Email").fill(email);
    await pageB.getByLabel("Password").fill(PASSWORD);
    await pageB.getByRole("button", { name: "Sign in" }).click();
    await expect(pageB).toHaveURL(/\/review$/);

    // Should resume at Card 2 (index 1)
    await expect(pageB.getByText("Card 2 of 3")).toBeVisible();

    await contextA.close();
    await contextB.close();
  });

  test("due and new queues sync independently", async ({ browser }) => {
    const email = uniqueEmail("dualqueue");

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signUp(pageA, email);

    // Add words and review some to create both due and new history
    const words = [
      { word: "dog", translation: "狗" },
      { word: "elephant", translation: "大象" },
      { word: "fox", translation: "狐狸" },
    ];
    await addWordsViaAPI(pageA, words);

    await pageA.goto("/review");
    await expect(pageA.getByText("Card 1 of 3")).toBeVisible();

    // Review 1 card
    await pageA.getByRole("button", { name: /Good/ }).click();
    await expect(pageA.getByText("Card 2 of 3")).toBeVisible();
    await pageA.waitForTimeout(1000);

    // Switch to "New" queue (if UI supports it) - verify both queues tracked
    // Note: depends on ReviewSession UI for queue switching

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.goto("/login");
    await pageB.getByLabel("Email").fill(email);
    await pageB.getByLabel("Password").fill(PASSWORD);
    await pageB.getByRole("button", { name: "Sign in" }).click();
    await expect(pageB).toHaveURL(/\/review$/);
    await expect(pageB.getByText("Card 2 of 3")).toBeVisible();

    await contextA.close();
    await contextB.close();
  });
});
```

- [ ] **Step 2: Run the test**

```bash
bunx playwright test tests/e2e/review-sync.spec.ts --project=chromium
```

Expected: Both tests pass.

- [ ] **Step 3: Run full test suite**

```bash
bunx playwright test --project=chromium
```

Expected: All 11 tests pass (2 dictionary + 7 auth + 2 review-sync).

- [ ] **Step 4: TypeScript check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/review-sync.spec.ts
git commit -m "test: add cross-device review sync E2E tests"
```

---

### Task 6: Final verification and cleanup

- [ ] **Step 1: Full typecheck**

```bash
bunx tsc --noEmit
```

- [ ] **Step 2: Full test suite**

```bash
bunx playwright test --project=chromium
```

- [ ] **Step 3: Build verification**

```bash
NEXT_DIST_DIR=.next-final bunx next build
```

- [ ] **Step 4: Run migration on live Turso**

```bash
bun run migrate:multiuser
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: cross-device review cursor sync (Stage 2)"
```

---

## Summary

| Task | Description |
|------|-------------|
| 1 | Schema + migration for `review_sessions` |
| 2 | DB operations: `getReviewSession`, `upsertReviewSession` |
| 3 | `/api/review-state` GET/POST endpoints |
| 4 | `ReviewSession.tsx` server sync integration |
| 5 | E2E tests for cross-device sync |
| 6 | Final verification |

Total: ~6 tasks, each with explicit code, commands, and verification steps.