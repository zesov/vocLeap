# Review History Pagination + Words Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paginate the review history list and add date/alphabetical sorting to the words list, both driven by the database so infinite scroll stays correct.

**Architecture:** Extend the existing offset-pagination contract (`limit` + `offset` + `hasMore`) used by `/api/words` to review history, and add a whitelisted `sort` parameter to `/api/words`. Both pages mirror the words page's `IntersectionObserver` sentinel and append behaviour.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, SQLite (better-sqlite3 / libsql), Playwright.

---

## Part A — Review History Pagination

### Task A1: Paginated history query

**Files:**
- Modify: `lib/db/operations.ts` (already in progress, `getReviewHistoryPage`)

- [x] Replace the keyset cursor implementation with an offset page that returns `{ entries, total }`.
- [x] Keep `ORDER BY rh.reviewed_at DESC, rh.id DESC` so rows sharing a `reviewed_at` second stay stable.
- [ ] Verify: `bunx tsc --noEmit`.

### Task A2: Paginated history API

**Files:**
- Modify: `app/api/reviews/route.ts`

- [ ] Write the failing E2E test first (`tests/e2e/review-history.spec.ts`, Task A5).
- [ ] Import `getReviewHistoryPage` and replace the `action === "history"` branch:

```ts
if (action === "history") {
  const limitParam = Number.parseInt(searchParams.get("limit") || "30", 10);
  const offsetParam = Number.parseInt(searchParams.get("offset") || "0", 10);
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(limitParam) ? limitParam : 30, 100)
  );
  const offset = Math.max(Number.isFinite(offsetParam) ? offsetParam : 0, 0);
  const { entries, total } = await getReviewHistoryPage(user.id, limit, offset);

  return NextResponse.json({
    history: entries,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  });
}
```

- [ ] Leave `action === "history" && wordId` unchanged (single-word history is still unpaginated).

### Task A3: Index for history ordering

**Files:**
- Modify: `lib/db/init.ts`

- [ ] Add next to the existing `idx_review_history_word` line:

```ts
await db.exec(
  `CREATE INDEX IF NOT EXISTS idx_review_history_reviewed ON review_history(reviewed_at DESC, id DESC)`
);
```

### Task A4: Infinite scroll page

**Files:**
- Modify: `app/(app)/review-history/page.tsx`

- [ ] Mirror `app/(app)/words/page.tsx`:
  - `ITEMS_PER_PAGE = 30`
  - state: `history`, `loading`, `loadingMore`, `offset`, `hasMore`, `error`
  - `fetchHistory(nextOffset, append)` hits `/api/reviews?action=history&limit=30&offset=N`
  - append via `setHistory(prev => [...prev, ...data.history])`
  - `IntersectionObserver` sentinel `<div ref={observerRef} className="h-1" />`
  - "Loading more history..." indicator while `hasMore`
  - empty state and error state kept from the current page
- [ ] Keep the existing table markup unchanged.

### Task A5: Review history E2E test

**Files:**
- Create: `tests/e2e/review-history.spec.ts`

- [ ] Seed 32 words and rate each one through `POST /api/reviews`.
- [ ] Assert page 1: `history.length === 30`, `total === 32`, `hasMore === true`.
- [ ] Assert page 2: `history.length === 2`, `hasMore === false`.
- [ ] Assert ordering: page 1 starts with the last-rated word, page 2 ends with the first-rated word.
- [ ] UI: open `/review-history`, expect 30 rows, scroll to the sentinel, expect 32 rows and no "Loading more history...".

### Task A6: Docs

- [ ] Add a `## [2026-11-05] Review History Pagination` section to `CHANGELOG.md`.
- [ ] Update the review-history notes in `AGENTS.md` (currently says "returns all history").

---

## Part B — Words List Sorting

### Task B1: Sortable query

**Files:**
- Modify: `lib/db/operations.ts`

- [ ] Add:

```ts
export type WordSort = "date_desc" | "date_asc" | "alpha_asc" | "alpha_desc";

const WORD_SORT_CLAUSES: Record<WordSort, string> = {
  date_desc: "created_at DESC, id DESC",
  date_asc: "created_at ASC, id ASC",
  alpha_asc: "word COLLATE NOCASE ASC, id ASC",
  alpha_desc: "word COLLATE NOCASE DESC, id DESC",
};

export function isWordSort(value: unknown): value is WordSort {
  return typeof value === "string" && value in WORD_SORT_CLAUSES;
}
```

- [ ] Change `getAllWords(userId, limit = 50, offset = 0, sort: WordSort = "date_desc")` and use `WORD_SORT_CLAUSES[sort]` in the `ORDER BY`.
- [ ] Keep the `{ words, total }` return shape.

### Task B2: Sort-aware API

**Files:**
- Modify: `app/api/words/route.ts`

- [ ] Read `sort`, fall back to `date_desc` for unknown values.
- [ ] Guard `limit`/`offset` against `NaN`.
- [ ] Return the resolved `sort` in the JSON payload.

### Task B3: Sort control

**Files:**
- Modify: `app/(app)/words/page.tsx`

- [ ] Add `type SortOption` and `SORT_OPTIONS` (Newest first, Oldest first, A–Z, Z–A).
- [ ] Add `sort` state, pass it to the request, and return the resolved sort into state.
- [ ] `handleSortChange` clears the list, resets offset/hasMore, and loads page 1.
- [ ] Render the existing `Select` next to `Import Words` (`aria-label="Sort words"`).
- [ ] When an import succeeds, reload page 1 with the current sort.
- [ ] Reset `loading` when loading page 1 and keep `loadingMore` for appended pages.

### Task B4: Words sorting E2E test

**Files:**
- Create: `tests/e2e/words-sort.spec.ts`

- [ ] API: seed `banana`, `apple`, `cherry`; assert `date_desc` = cherry/banana/apple, `alpha_asc` = apple/banana/cherry, `alpha_desc` = cherry/banana/apple, `oldest` = apple/banana/cherry.
- [ ] API: `sort=bogus` returns `sort=date_desc`.
- [ ] UI: seed 35 zero-padded words, select A–Z, expect `word-01` first; scroll, expect `word-35` appended and 35 cards total.

### Task B5: Docs and verification

- [ ] Add a `## [2026-11-05] Words List Sorting` section to `CHANGELOG.md`.
- [ ] Mention the sort control in the `words/page.tsx` note in `AGENTS.md`.
- [ ] Run `bunx tsc --noEmit`.
- [ ] Run `bunx eslint` on the changed source files.
- [ ] Run the new Playwright specs plus `review-queue` and `review-sync`.
- [ ] Commit each feature separately.

---

## Verification Commands

```bash
bunx tsc --noEmit
bunx eslint app/api/reviews/route.ts app/api/words/route.ts \
  "app/(app)/review-history/page.tsx" "app/(app)/words/page.tsx" \
  lib/db/operations.ts lib/db/init.ts tests/e2e/review-history.spec.ts \
  tests/e2e/words-sort.spec.ts
bunx playwright test tests/e2e/review-history.spec.ts tests/e2e/words-sort.spec.ts \
  --project=chromium --reporter=line
bunx playwright test tests/e2e/review-queue.spec.ts tests/e2e/review-sync.spec.ts \
  --project=chromium --reporter=line
```
