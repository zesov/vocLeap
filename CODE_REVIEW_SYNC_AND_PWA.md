# Code Review: Sync Logic & PWA White Screen on Poor Network

**Date:** 2026-11-19
**Scope:** `lib/local-db/sync/`, `components/LocalDbInit.tsx`, `components/SWWarmup.tsx`, `app/sw.ts`, `lib/pwa/turbopack-worker-shim.ts`

---

## Executive Summary

Two distinct but related issues:

| Issue | Severity | Root Cause |
|-------|----------|------------|
| **Sync logic correctness** | Medium | Race conditions in duplicate adoption, missing idempotency for history merges, scheduler doesn't handle `pagehide` race |
| **PWA white screen on poor network** | High | Local DB init blocks UI, no fallback rendering during bootstrap, SW doesn't cache app shell for offline-first load |

---

## 1. Local ↔ Remote Sync Logic Review

### 1.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client (Browser)                          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │  SQLite     │    │  Sync Oplog │    │  Sync Engine        │  │
│  │  (Worker)   │◄───│  (sync_ops) │───►│  push / pull / merge│  │
│  └─────────────┘    └─────────────┘    └──────────┬──────────┘  │
│         │                                        │             │
│         ▼                                        ▼             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Data Facade (getData/useData)              │   │
│  │  Local-first reads; writes → local DB + enqueue oplog   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Server (Next.js API)                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │  /sync/push │    │  /sync/pull │    │  better-sqlite3 /   │  │
│  │  (idempotent)    │  (cursor)   │    │  Turso (libsql)     │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Critical Findings

#### 🔴 **CRITICAL: Duplicate Adoption Race Condition** (`merge.ts:164-185`)

**Problem:** When two devices create the same word offline, the server folds the second push into the first row (keeping the first UUID). On pull, the client tries to "adopt" its local duplicate under the server's UUID. However:

```typescript
// merge.ts:170-175
const dup = otherRows.find((row) => !pendingWords.has(row.uuid));
if (dup) {
  steps.push(...adoptionSteps(payload, dup.uuid)); // <-- RUNS INSIDE LOOP
}
```

**Race:** If `pushPendingOps` runs concurrently (scheduler tick + `requestSync` from user action), the local duplicate might have a pending op (`pendingWords.has(row.uuid) === true`). The adoption skips, but the incoming word insert (`ON CONFLICT(uuid) DO NOTHING` at line 193) fails because the **unique index on `(word, deleted_at)` where `deleted_at IS NULL`** still has the local duplicate row. The server's UUID row never inserts.

**Evidence:** The code at lines 179-186 detects this but only `continue`s (skips the word this cycle), relying on the next pull cycle. But the push batch cap (`MAX_PUSH_BATCHES = 10`, 200 ops each) means the pending op might not push this cycle if the queue is deep.

**Fix:** Adoption must run in a **separate transaction phase before any inserts**, or the unique index must be `(word, uuid)` not `(word, deleted_at)`. Simpler: do a pre-pass that collects all adoptions, executes them in one batch, then proceeds with inserts.

---

#### 🔴 **CRITICAL: History Merge Not Idempotent for Concurrent Local+Remote** (`merge.ts:302-342`)

**Problem:** `review_history` uses `ON CONFLICT(uuid) DO NOTHING` (line 323). This is correct for pure server→client. But if the client has a **local history entry with the same UUID** (generated locally before push), and the server returns a **different entry with the same UUID** (impossible with uuidv7, but possible if the server reuses UUIDs or there's a bug), the local entry wins silently.

**More likely issue:** The client generates UUIDs for history entries locally (`uuidv7()` in `submitReviewLocal`). The server also generates UUIDs when applying review ops. If the server applies the review op, it creates a history entry with a **new server UUID**. The pull brings this server UUID. The local DB already has the **local UUID** for the same review. Now there are **two history rows for one review** — one with local UUID, one with server UUID.

**Fix:** History merge should match by `(word_uuid, reviewed_at, rating)` composite key, not just UUID. Or: client should not generate history UUIDs locally — let the server be the sole authority.

---

#### 🟡 **HIGH: Sync Scheduler Doesn't Handle `pagehide` Race** (`engine.ts:285-319`, `trigger.ts:36-45`)

**Problem:** `flushPendingOpsOnPageExit` fires `pushPendingOps` with `keepalive: true`. But `startSyncScheduler` also runs `runSyncOnce` every 60s and on `visibilitychange`. If `pagehide` and `visibilitychange` (hidden) fire close together:

1. `flushPendingOpsOnPageExit` pushes ops
2. Scheduler's `onVisible` (fired on `visibilitychange` to hidden? No, only on visible) — actually `onVisible` only runs when `document.visibilityState === "visible"` (line 304-305)
3. But `run()` is also called directly at line 308 (initial) and by `setInterval`

The real issue: `runSyncOnce` sets `running = true` (line 196) but **doesn't clear it on `pagehide`**. If the page unloads mid-sync, `running` stays `true` forever in that worker context. Next session's `runSyncOnce` returns early at line 194.

**Fix:** Add `beforeunload`/`pagehide` handler that sets `running = false`. Or better: make `running` a `localStorage` flag so it survives worker restart.

---

#### 🟡 **HIGH: Push Batch Size vs. Oplog Growth** (`engine.ts:29`, `oplog.ts:33`)

- `MAX_PUSH_BATCHES = 10` × 200 ops = **2000 ops max per cycle**
- Bulk import of 5000 words → 5000 word ops + 5000 history ops = 10,000 ops
- At 2000/cycle, takes **5 cycles** (5 min with 60s interval) to clear
- During this, `pendingWords.has(payload.uuid)` returns true for all un-pushed words
- **Merge skips all those words** (line 165), so the user sees stale data

**Fix:** Increase batch size or add a "drain mode" that pushes continuously until empty when `pendingCount > 1000`.

---

#### 🟡 **MEDIUM: Cursor Stuck on Pull Error** (`engine.ts:216-236`)

```typescript
for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
  const response = await timedFetch(...);
  if (!response.ok) throw new Error(...); // <-- cursor NOT updated
  // ...
  cursor = next; // only updated on success
  await setMeta(db, "sync_cursor", JSON.stringify(cursor));
}
```

If page 3 of 10 fails (network blip), the cursor stays at page 2's value. Next cycle re-fetches page 3. **Correct behavior**, but the error surfaces as `phase: "error"` and the scheduler retries in 60s. User sees "Network too slow" banner for 60s.

**Improvement:** On pull error, don't throw — just `break` and keep the cursor at last successful page. The error phase is too noisy for transient network blips.

---

#### 🟡 **MEDIUM: No Exponential Backoff on Repeated Failures** (`engine.ts:251-264`)

Sync errors (non-401) immediately set `phase: "error"` and the scheduler retries in 60s flat. On persistent failure (server down, bad deploy), this hammers the server every 60s forever.

**Fix:** Track consecutive failures, back off exponentially (60s → 2m → 5m → 15m → 30m max), reset on success.

---

#### 🟢 **LOW: `rejectedOpId` Not Cleared on Successful Retry** (`engine.ts:163-170`)

When `paused = true` and `rejectedOpId` is set, a user clicks "Retry" → `resetSyncPause()` → `requestSync()`. If the retry succeeds, `paused` becomes `false` but `rejectedOpId` stays in status until next `emit()` with `rejectedOpId: null`. The `runSyncOnce` success path (line 244-250) does clear it, but `pushPendingOps` called directly by `requestSync` doesn't go through that path.

**Fix:** `resetSyncPause()` already emits `rejectedOpId: null` (line 70). ✓ Actually this is handled. But `pushPendingOps` success path (line 173) returns without emitting `rejectedOpId: null`. If the user clicks Retry and the push succeeds, the status still shows the old `rejectedOpId` until the next full sync cycle. Minor UI confusion.

---

#### 🟢 **LOW: `sameCursor` Comparison Includes `hId` (History)** (`engine.ts:88-96`)

```typescript
function sameCursor(a: SyncCursor, b: SyncCursor): boolean {
  return (
    a.wTs === b.wTs &&
    a.wId === b.wId &&
    a.rTs === b.rTs &&
    a.rId === b.rId &&
    a.hId === b.hId    // <-- history cursor
  );
}
```

History is append-only and never updated. Including `hId` in "settled" check means: if no new history since last pull, `settledCursor = true` and pull stops early. **This is correct and efficient.** But if history *is* growing, `hId` changes every pull page, so `settledCursor` is always false and `MAX_PULL_PAGES` (20) limits the pull. With 20 pages × 100 history rows = 2000 history rows max per cycle. Acceptable.

---

### 1.3 Server-Side Sync Review (Brief)

**`lib/sync/server-apply.ts`** — Idempotent apply with LWW:
- Words: by `updated_at` (correct)
- Reviews: by `last_reviewed` (correct)
- History: `INSERT ... ON CONFLICT(uuid) DO NOTHING` (correct for server-generated UUIDs)

**Potential issue:** Server doesn't validate that the `word_uuid` in a review/history op exists in the words table. A malicious or buggy client could orphan reviews. Not a practical concern (authenticated users only).

---

### 1.4 Recommended Fixes Priority Order

| Priority | File | Change |
|----------|------|--------|
| P0 | `merge.ts` | Pre-pass adoption phase before inserts; handle pending duplicates atomically |
| P0 | `merge.ts` | History merge by composite key `(word_uuid, reviewed_at, rating)` |
| P1 | `engine.ts` | Add `beforeunload` handler to clear `running` flag |
| P1 | `engine.ts` | Exponential backoff for sync errors |
| P1 | `engine.ts` | On pull error, don't throw — preserve cursor, set transient error phase |
| P2 | `engine.ts` | Drain mode for large oplog (push continuously when `pending > 1000`) |
| P2 | `trigger.ts` | Coordinate `flushPendingOpsOnPageExit` with scheduler (cancel scheduled run) |
| P3 | `engine.ts` | Clear `rejectedOpId` in `pushPendingOps` success path |

---

## 2. PWA White Screen on Poor Network

### 2.1 Current Flow (Problematic)

```
User opens PWA (offline/slow)
         │
         ▼
┌────────────────────────────────────────┐
│  Service Worker (Serwist)              │
│  - precacheEntries: app shell          │
│  - fallback: /~offline for documents   │
│  - NetworkOnly for /api/*              │
└────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│  RootLayout (app/layout.tsx)           │
│  <SerwistProvider reloadOnOnline={false}>│
│    <SWWarmup />  ← caches current URL  │
│    {children}                          │
└────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│  ProtectedLayout (app/(app)/layout.tsx)│
│  await getCurrentUser()  ← BLOCKS      │
│  await getUserAlgorithm()  ← BLOCKS    │
│  <LocalDbInit />                       │
│    initLocalDb()                       │
│      acquireLock()                     │
│      new Worker(sqlite-worker.ts)      │
│      worker.postMessage({type:"init"}) │
│      await migrateLocalSchema()        │
│      await bootstrap pull (2.5s deadline)│
│      startSyncScheduler()              │
│    Returns null (no UI)                │
└────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│  Page Component (e.g., /review)        │
│  useData() → getData()                 │
│    if local DB ready → local           │
│    else → remote (fetch with 6s timeout)│
└────────────────────────────────────────┘
```

**White screen occurs because:**
1. `ProtectedLayout` is a **Server Component** with `await getCurrentUser()` — blocks streaming
2. `LocalDbInit` initializes the **entire local DB + bootstrap pull** before any child renders
3. `bootstrap: (db) => withDeadline(runSyncOnce(db), 2500)` — on slow network, this takes 2.5s **minimum**
4. No loading UI, no skeleton, no streaming — the entire page is blank until done

---

### 2.2 Root Causes

#### 🔴 **CRITICAL: Server Component Blocks on Auth + Local DB Init**

`app/(app)/layout.tsx`:
```typescript
const user = await getCurrentUser();        // Blocking DB read
const srsAlgorithm = await getUserAlgorithm(user.id); // Another blocking read

return (
  <LocalDbInit userId={user.id} ... />     // Starts async init, renders null
  <NavBar />
  <SyncStatus />
  <main>{children}</main>
);
```

**Problems:**
- `getCurrentUser()` reads session cookie → decrypts → queries SQLite. On slow disk/CPU, 100-500ms.
- `getUserAlgorithm()` another query.
- `LocalDbInit` starts worker, migrates schema, runs bootstrap pull (up to 2.5s).
- **No Suspense boundary** — Next.js can't stream anything until the whole layout resolves.

#### 🔴 **CRITICAL: No Offline-First App Shell Caching**

`app/sw.ts` runtime caching:
```typescript
// defaultCache includes:
// - documents: NetworkFirst (HTML)
// - _next/static: CacheFirst
// - fonts, images: CacheFirst
```

But **no explicit precache of the app shell HTML**. `self.__SW_MANIFEST` only includes Next.js build output (JS/CSS chunks), not the dynamic route HTML.

When offline:
1. SW receives navigation request for `/review`
2. `defaultCache` document handler: `NetworkFirst` → tries network → fails
3. Falls back to `/~offline` (the `fallbacks` config at line 113-122)
4. **`/~offline` is a minimal page, not the app shell** — user sees "You're offline" instead of cached review UI with local data

#### 🟡 **HIGH: Local DB Init Has No Progress UI**

`LocalDbInit` renders `null` throughout. The user sees:
- Blank white screen (if `ProtectedLayout` hasn't rendered)
- Or just `NavBar` + empty `<main>` (if layout streamed but children wait for data)

`SyncStatus` only shows banners **after** local DB is `ready` or `failed` (line 36: `if (local.status === "idle" || local.status === "init") return null;`).

#### 🟡 **HIGH: `withDeadline` Swallows Bootstrap Errors Silently**

```typescript
// LocalDbInit.tsx:48
bootstrap: (db) => withDeadline(runSyncOnce(db), BOOTSTRAP_DEADLINE_MS),
// ...
// LocalDbInit.tsx:292-298
if (options.bootstrap) {
  try {
    await options.bootstrap(db);
  } catch {
    // Bootstrap is best-effort: the background scheduler retries.
  }
}
```

If bootstrap pull times out (2.5s), `withDeadline` resolves `null`, no error thrown. The local DB publishes as `ready` **with zero server data**. Components using `getData()` get local implementation but see empty tables. User sees empty review queue, empty word list — looks like data loss.

#### 🟢 **MEDIUM: `SWWarmup` Only Caches Current URL**

```typescript
// SWWarmup.tsx:19-22
serwist.messageSW({
  type: "CACHE_URLS",
  payload: { urlsToCache: [window.location.href] },
});
```

Only caches the **current page**. If user opens PWA to `/review` (offline), then navigates to `/words` — `/words` HTML not cached, shows `/~offline`.

---

### 2.3 Recommended Fixes Priority Order

| Priority | Area | Change |
|----------|------|--------|
| P0 | `app/(app)/layout.tsx` | Move `LocalDbInit` and auth to **Client Component** with `Suspense` boundary; stream `NavBar` immediately |
| P0 | `app/sw.ts` | Add **app shell precaching**: cache `/review`, `/words`, `/review-history`, `/dictionary` HTML at build time or on first visit |
| P0 | `components/LocalDbInit.tsx` | Add loading state: render `SyncStatus`-style banner during `init`/`busy`; don't return `null` |
| P1 | `lib/deadline.ts` / `LocalDbInit.tsx` | On bootstrap timeout, **emit warning status** so UI shows "Loading server data…" instead of silent empty state |
| P1 | `components/SWWarmup.tsx` | Warm **all critical routes** (`/review`, `/words`, `/review-history`, `/dictionary`) not just current URL |
| P2 | `app/sw.ts` | Change document handler from `NetworkFirst` to **`StaleWhileRevalidate`** for app routes — show cached HTML immediately, update in background |
| P2 | `app/(public)/layout.tsx` | Same Suspense/streaming fix for public pages with auth |
| P3 | `lib/pwa/turbopack-worker-shim.ts` | Verify shim works for **service worker served worker chunks** (cached by SW) — currently only handles main thread `new Worker` |

---

## 3. Combined Impact: Why White Screen + Sync Issues Compound

```
Slow network (e.g., 3G, high latency)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Page load: SW serves cached JS/CSS (fast)                │
│ 2. HTML: NetworkFirst → 10s timeout → fallback to /~offline │
│    OR: no cached HTML → white screen until network responds │
│ 3. If HTML loads: ProtectedLayout blocks on auth (200-500ms)│
│ 4. LocalDbInit starts: worker boot (300ms) + schema (100ms) │
│ 5. Bootstrap pull: 2.5s deadline → times out → empty local  │
│ 6. Page renders: empty review list, empty words list        │
│ 7. User thinks: "App broken" or "Data lost"                 │
│ 8. Background sync: scheduler retries every 60s             │
│ 9. If sync fails repeatedly: no backoff → hammers server    │
│ 10. Duplicate adoption race: local words never merge        │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Implementation Plan

### Phase 1: Fix White Screen (P0 — Can ship independently)

1. **Create `AppShell` Client Component** wrapping auth + LocalDbInit with Suspense
2. **Add Suspense boundaries** in `(app)/layout.tsx` and `(public)/layout.tsx`
3. **Precache app shell routes** in `app/sw.ts` (use `serwist.precache` or runtime caching with `StaleWhileRevalidate`)
4. **Add loading banner** in `LocalDbInit` for `init`/`busy` states

### Phase 2: Fix Sync Correctness (P0-P1 — Requires testing)

1. **Refactor `mergePullPage`**: Pre-pass adoption batch before inserts
2. **Fix history merge**: Composite key deduplication
3. **Add `beforeunload` handler** to clear `running` flag
4. **Implement exponential backoff** in scheduler

### Phase 3: Polish (P2-P3)

1. **Warm all routes** in `SWWarmup`
2. **Drain mode** for large oplog
3. **Bootstrap timeout warning** in UI

---

## 5. Code Snippets for Key Fixes

### 5.1 Suspense Layout (Fixes White Screen)

```tsx
// app/(app)/layout.tsx
import { Suspense } from "react";
import { getCurrentUser } from "@/lib/auth/session";
import NavBar from "@/components/NavBar";
import SyncStatus from "@/components/SyncStatus";
import { AuthenticatedContent } from "./authenticated-content"; // NEW client component

export const instant = false;

export default async function ProtectedLayout({
  children,
}: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <NavBar initialUser={user} />
      <SyncStatus />
      <main className="flex-1">
        <Suspense fallback={<AppShellSkeleton />}>
          <AuthenticatedContent userId={user.id} email={user.email}>
            {children}
          </AuthenticatedContent>
        </Suspense>
      </main>
    </div>
  );
}

// app/(app)/authenticated-content.tsx
"use client";
import { useEffect } from "react";
import LocalDbInit from "@/components/LocalDbInit";
import { getUserAlgorithm } from "@/lib/db/operations";

interface AuthenticatedContentProps {
  userId: number;
  email: string;
  children: React.ReactNode;
}

export function AuthenticatedContent({ userId, email, children }: AuthenticatedContentProps) {
  const [algorithm, setAlgorithm] = useState<"sm2" | "fsrs">("sm2");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getUserAlgorithm(userId).then(setAlgorithm).finally(() => setReady(true));
  }, [userId]);

  if (!ready) return <AppShellSkeleton />; // or null if skeleton at layout level

  return (
    <LocalDbInit userId={userId} email={email} srsAlgorithm={algorithm}>
      {children}
    </LocalDbInit>
  );
}
```

### 5.2 App Shell Precaching in SW

```typescript
// app/sw.ts — add to runtimeCaching BEFORE defaultCache
{
  // App shell routes: serve cached HTML immediately, revalidate in background
  matcher: ({ url }) => {
    const pathname = url.pathname;
    return ["/review", "/words", "/review-history", "/dictionary", "/"].some(
      (route) => pathname === route || pathname.startsWith(route + "/")
    );
  },
  handler: new StaleWhileRevalidate({
    cacheName: "app-shell",
    plugins: [
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 7 * DAY_SECONDS }),
    ],
  }),
},
```

### 5.3 Adoption Pre-Pass in Merge

```typescript
// merge.ts — replace lines 164-231 with:

// PHASE 1: Collect all adoptions needed
const adoptions: Array<{ payload: WordPayload; dupUuid: string }> = [];
for (const payload of page.words) {
  if (pendingWords.has(payload.uuid)) continue;
  const dup = otherTextRows(payload).find((row) => !pendingWords.has(row.uuid));
  if (dup) adoptions.push({ payload, dupUuid: dup.uuid });
}

// PHASE 2: Execute all adoptions in ONE batch (before any inserts)
if (adoptions.length > 0) {
  const adoptionSteps = adoptions.flatMap(({ payload, dupUuid }) =>
    adoptionSteps(payload, dupUuid)
  );
  await db.batch(adoptionSteps);
  // Update localWords map after adoptions
  for (const { payload, dupUuid } of adoptions) {
    localWords.delete(dupUuid);
    localWords.set(payload.uuid, { ...payload, server_id: payload.serverId ?? null });
  }
}

// PHASE 3: Insert/update remaining words (existing logic from line 177)
for (const payload of page.words) {
  if (pendingWords.has(payload.uuid)) continue;
  // ... existing insert/update logic
}
```

### 5.4 Exponential Backoff in Scheduler

```typescript
// engine.ts — add to SyncStatus and scheduler
export interface SyncStatus {
  // ... existing
  consecutiveErrors: number;
  nextRetryAt: string | null;
}

let consecutiveErrors = 0;
const BASE_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 30 * 60 * 1000; // 30 min

function computeBackoff(errors: number): number {
  return Math.min(BASE_INTERVAL_MS * Math.pow(2, errors), MAX_INTERVAL_MS);
}

// In runSyncOnce catch block:
catch (error) {
  if (error instanceof AuthRequiredError) { /* ... */ }
  consecutiveErrors += 1;
  const nextRetryAt = new Date(Date.now() + computeBackoff(consecutiveErrors)).toISOString();
  return emit({
    phase: "error",
    pending: await pendingCount(db),
    error: error instanceof Error ? error.message : String(error),
    consecutiveErrors,
    nextRetryAt,
  });
}

// In success path (line 244):
consecutiveErrors = 0;
return emit({ ..., consecutiveErrors: 0, nextRetryAt: null });

// In startScheduler, use dynamic interval:
const run = () => {
  const intervalMs = computeBackoff(consecutiveErrors);
  // ...
  timer = setTimeout(run, intervalMs);
};
```

---

## 6. Testing Checklist

### Sync Logic
- [ ] Two devices create same word offline → both sync → single row on server, both clients adopt correctly
- [ ] Large bulk import (5000 words) → oplog drains in <2 min (not 5+ min)
- [ ] Network fails mid-pull → cursor preserved, next cycle resumes from last page
- [ ] Page unload mid-sync → next session syncs normally (running flag cleared)
- [ ] Server rejects op (e.g., validation error) → pause → discard → rest of queue syncs
- [ ] Concurrent `requestSync` + scheduler tick → no double-push, no missed ops

### PWA Offline/Slow Network
- [ ] Open PWA offline → cached `/review` HTML loads instantly with local data
- [ ] Open PWA on slow 3G → skeleton shows within 200ms, content streams in
- [ ] Navigate between `/review`, `/words`, `/review-history` offline → all work
- [ ] Bootstrap pull times out → UI shows "Loading server data…" not empty state
- [ ] Service worker update → no white flash, smooth transition

---

## 7. Files to Modify (Summary)

| File | Changes |
|------|---------|
| `app/(app)/layout.tsx` | Move auth to client, add Suspense, extract AuthenticatedContent |
| `app/(app)/authenticated-content.tsx` | **NEW** — Client component with LocalDbInit |
| `app/(public)/layout.tsx` | Same pattern for public pages |
| `app/sw.ts` | Add app-shell StaleWhileRevalidate route, precache critical routes |
| `components/LocalDbInit.tsx` | Show loading banner during init; emit bootstrap timeout warning |
| `components/SWWarmup.tsx` | Warm all critical routes, not just current URL |
| `lib/local-db/sync/merge.ts` | Adoption pre-pass, history composite-key dedup |
| `lib/local-db/sync/engine.ts` | Exponential backoff, beforeunload handler, pull error handling |
| `lib/local-db/sync/trigger.ts` | Coordinate pagehide flush with scheduler |
| `lib/deadline.ts` | Export timeout status for UI consumption |

---

**Reviewed by:** Orchestrator (AI)
**Next steps:** Prioritize Phase 1 (white screen) as it blocks user access entirely. Phase 2 (sync correctness) prevents data divergence but requires careful testing with multi-device scenarios.