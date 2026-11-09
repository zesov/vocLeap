# Due-timezone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "due now" respect the user's timezone — SM-2 schedules the next review at the *user's* local midnight (stored as UTC), and zone-less DB timestamps parse as UTC everywhere.

**Architecture:** DB stays UTC; the user-local day boundary is converted to its exact UTC instant at write time (`lib/timezone.ts`), so the existing `next_review_date <= datetime('now')` SQL comparisons stay unchanged and correct. The browser sends its IANA timezone with each review submission; missing/invalid timezone falls back to today's server-local behavior. FSRS stays instant-based (user decision) but gains a UTC-parsing fix for zone-less DB strings.

**Tech Stack:** TypeScript, `Intl.DateTimeFormat` (no new deps), bun test (co-located `*.test.ts`), Next.js API route, React client.

**Spec:** `docs/superpowers/specs/2026-11-09-due-timezone-design.md`

**Conventions observed in this repo:**
- Unit tests live next to the source (`lib/srs/fsrs.test.ts`), import from `bun:test` with relative paths, and are **excluded from tsc** in `tsconfig.json` (`bun:test` types are not available there).
- `lib/` imports are relative (`./init`, `./fsrs`); `app/`+`components/` use the `@/` alias.
- `formatDateForDB(date)` → `"YYYY-MM-DD HH:MM:SS"` in UTC — the DB's stored format.

---

### Task 1: Timezone helpers (`lib/timezone.ts`)

**Files:**
- Create: `lib/timezone.ts`
- Create: `lib/timezone.test.ts`
- Modify: `tsconfig.json` (exclude the new test file from tsc)

- [x] **Step 1: Write the failing test**

Create `lib/timezone.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { addCalendarDaysInZone, resolveClientTimezone } from "./timezone";

describe("addCalendarDaysInZone", () => {
  test("Asia/Hong_Kong: next day's local midnight lands at 16:00 UTC the day before", () => {
    // 2026-11-09 12:00 UTC == 2026-11-09 20:00 HKT
    const now = new Date("2026-11-09T12:00:00.000Z");
    const due = addCalendarDaysInZone("Asia/Hong_Kong", now, 1);
    // 2026-11-10 00:00 HKT == 2026-11-09 16:00 UTC
    expect(due.toISOString()).toBe("2026-11-09T16:00:00.000Z");
  });

  test("UTC: local midnight is exactly midnight UTC", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    expect(addCalendarDaysInZone("UTC", now, 1).toISOString()).toBe(
      "2026-11-10T00:00:00.000Z"
    );
  });

  test("America/New_York: boundaries stay at local midnight across the DST end", () => {
    // 2026-10-31 20:00 UTC == 16:00 EDT (UTC-4)
    const now = new Date("2026-10-31T20:00:00.000Z");
    // 2026-11-01 00:00 EDT == 04:00 UTC (DST still active at that midnight)
    expect(addCalendarDaysInZone("America/New_York", now, 1).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z"
    );
    // 2026-11-02 00:00 EST == 05:00 UTC (DST ended 02:00 local on Nov 1)
    expect(addCalendarDaysInZone("America/New_York", now, 2).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z"
    );
  });

  test("rolls over month and year boundaries", () => {
    const now = new Date("2026-12-31T12:00:00.000Z");
    expect(addCalendarDaysInZone("UTC", now, 1).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });
});

describe("resolveClientTimezone", () => {
  test("accepts supported IANA zone names", () => {
    expect(resolveClientTimezone("Asia/Hong_Kong")).toBe("Asia/Hong_Kong");
    expect(resolveClientTimezone("UTC")).toBe("UTC");
  });

  test("rejects invalid or missing values", () => {
    expect(resolveClientTimezone("Not/AZone")).toBeNull();
    expect(resolveClientTimezone("")).toBeNull();
    expect(resolveClientTimezone("   ")).toBeNull();
    expect(resolveClientTimezone(42)).toBeNull();
    expect(resolveClientTimezone(null)).toBeNull();
    expect(resolveClientTimezone(undefined)).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test lib/timezone.test.ts`
Expected: FAIL — `Cannot find module './timezone'` (or equivalent).

- [x] **Step 3: Implement `lib/timezone.ts`**

```ts
/**
 * User-local day-boundary helpers.
 *
 * The database stores UTC instants (`YYYY-MM-DD HH:MM:SS`). "Due at the
 * user's local midnight" is resolved here into the exact UTC instant at
 * write time, so the read-side `next_review_date <= datetime('now')`
 * comparisons (UTC vs UTC) stay correct without any SQL change.
 */

/**
 * Offset of `timeZone` at `date`, in milliseconds, such that
 * `date.getTime() + offset` equals the zone's wall-clock time read as if it
 * were UTC (i.e. localWallAsUtc - utc).
 */
function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }

  const wallAsUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  );
  return wallAsUtc - date.getTime();
}

/**
 * The UTC instant of local midnight in `timeZone` on the calendar date
 * `days` after `date`'s local date there. Arithmetic happens on wall-clock
 * fields, so month/year roll over correctly and DST transitions cannot move
 * the boundary off midnight.
 */
export function addCalendarDaysInZone(
  timeZone: string,
  date: Date,
  days: number
): Date {
  // en-CA formats as ISO-like "YYYY-MM-DD".
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const [year, month, day] = local.split("-").map(Number);

  // Target local midnight, first written as if the wall clock were UTC.
  const wallAsUtc = Date.UTC(year, month - 1, day + days);
  // Resolve the zone offset at the target instant; correcting twice makes
  // instants right at a DST transition converge.
  const offset = getTimeZoneOffsetMs(new Date(wallAsUtc), timeZone);
  const timestamp = wallAsUtc - getTimeZoneOffsetMs(new Date(wallAsUtc - offset), timeZone);
  return new Date(timestamp);
}

/**
 * Returns `input` unchanged when it is a supported IANA time zone name,
 * otherwise null. Guards unvalidated client input before it reaches
 * Intl-based date math.
 */
export function resolveClientTimezone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    return null;
  }
  return trimmed;
}
```

- [x] **Step 4: Exclude the test file from tsc and run the test to verify it passes**

In `tsconfig.json`, extend `exclude` (currently ends with `"lib/srs/fsrs.test.ts"`):

```json
  "exclude": [
    "node_modules",
    "lib/srs/fsrs.test.ts",
    "lib/timezone.test.ts"
  ],
```

Run: `bun test lib/timezone.test.ts`
Expected: PASS — 6 tests.

- [x] **Step 5: Commit**

```bash
git add lib/timezone.ts lib/timezone.test.ts tsconfig.json
git commit -m "feat: add user-timezone day-boundary helpers"
```

---

### Task 2: SM-2 schedules the next review at the user's local midnight

**Files:**
- Modify: `lib/srs/sm2.ts` (interface + `nextReviewDate` computation, lines ~1-51)
- Create: `lib/srs/sm2.test.ts`
- Modify: `tsconfig.json` (exclude the new test file)

- [x] **Step 1: Write the failing test**

Create `lib/srs/sm2.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatDateForDB, sm2Algorithm } from "./sm2";

const base = { easeFactor: 2.5, interval: 0, repetitions: 0, rating: 4 };

describe("sm2Algorithm next-review boundary", () => {
  test("with a timezone, due is the user's local midnight (+interval days)", () => {
    // 2026-11-09 12:00 UTC == 20:00 HKT
    const now = new Date("2026-11-09T12:00:00.000Z");
    const result = sm2Algorithm({ ...base, rating: 4, timezone: "Asia/Hong_Kong", now });
    // interval 1 -> 2026-11-10 00:00 HKT == 2026-11-09 16:00 UTC
    expect(result.interval).toBe(1);
    expect(formatDateForDB(result.nextReviewDate)).toBe("2026-11-09 16:00:00");
  });

  test("near the user's local midnight, the calendar day follows their zone", () => {
    // 2026-11-09 16:30 UTC == 2026-11-10 00:30 HKT: the user is already on Nov 10
    const now = new Date("2026-11-09T16:30:00.000Z");
    const result = sm2Algorithm({ ...base, rating: 4, timezone: "Asia/Hong_Kong", now });
    // "tomorrow" on the user's calendar is Nov 11 00:00 HKT == Nov 10 16:00 UTC
    expect(formatDateForDB(result.nextReviewDate)).toBe("2026-11-10 16:00:00");
  });

  test("'again' lapses back to one day at the user's local midnight", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const result = sm2Algorithm({
      easeFactor: 2.5,
      interval: 10,
      repetitions: 3,
      rating: 0,
      timezone: "Asia/Hong_Kong",
      now,
    });
    expect(result.interval).toBe(1);
    expect(formatDateForDB(result.nextReviewDate)).toBe("2026-11-09 16:00:00");
  });

  test("without a timezone, the legacy server-local boundary is preserved", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const result = sm2Algorithm({ ...base, rating: 4, now });
    const legacy = new Date(now);
    legacy.setDate(legacy.getDate() + 1);
    legacy.setHours(0, 0, 0, 0);
    expect(formatDateForDB(result.nextReviewDate)).toBe(formatDateForDB(legacy));
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test lib/srs/sm2.test.ts`
Expected: FAIL — the timezone tests get a server-local boundary instead of the user-zone one (with the default machine TZ ≠ Asia/Hong_Kong), and TS rejects the unknown `timezone`/`now` properties.

- [x] **Step 3: Implement in `lib/srs/sm2.ts`**

Add the import at the top of the file:

```ts
import { addCalendarDaysInZone } from "../timezone";
```

Extend `SM2Input`:

```ts
export interface SM2Input {
  easeFactor: number;
  interval: number;
  repetitions: number;
  rating: number;
  /**
   * IANA time zone of the user (e.g. "Asia/Hong_Kong"). When given, the
   * next-review boundary is that zone's local midnight, stored as UTC.
   * Omitted -> legacy server-local boundary (old clients, tests).
   */
  timezone?: string;
  /** Reference "now"; defaults to the current time. */
  now?: Date;
}
```

Replace the boundary computation at the end of `sm2Algorithm`:

```ts
  const nextReviewDate = new Date();
  nextReviewDate.setDate(nextReviewDate.getDate() + newInterval);
  nextReviewDate.setHours(0, 0, 0, 0);
```

with:

```ts
  const referenceNow = now ?? new Date();
  let nextReviewDate: Date;
  if (timezone) {
    // "Today + interval days" on the user's calendar, at their local
    // midnight, expressed as the exact UTC instant for storage.
    nextReviewDate = addCalendarDaysInZone(timezone, referenceNow, newInterval);
  } else {
    // Legacy behavior (server-local midnight) when no timezone is supplied.
    nextReviewDate = new Date(referenceNow);
    nextReviewDate.setDate(nextReviewDate.getDate() + newInterval);
    nextReviewDate.setHours(0, 0, 0, 0);
  }
```

and extend the destructure at the top of the function:

```ts
  const { easeFactor, interval, repetitions, rating, timezone, now } = input;
```

- [x] **Step 4: Exclude the test file from tsc and run the tests**

In `tsconfig.json` `exclude`, add `"lib/srs/sm2.test.ts"` after `"lib/srs/fsrs.test.ts"`.

Run: `bun test lib/srs/sm2.test.ts`
Expected: PASS — 4 tests.

- [x] **Step 5: Commit**

```bash
git add lib/srs/sm2.ts lib/srs/sm2.test.ts tsconfig.json
git commit -m "feat: schedule SM-2 due at the user's local midnight"
```

---

### Task 3: Parse zone-less DB timestamps as UTC in FSRS

**Files:**
- Modify: `lib/srs/fsrs.ts` (`parseDateOrNull`, line ~82; `seedFsrsStateFromSm2`, line ~129)
- Modify: `lib/srs/fsrs.test.ts` (append two `describe` blocks)

- [x] **Step 1: Write the failing tests**

Append to the end of `lib/srs/fsrs.test.ts` (also add `parseDateOrNull` to the existing import from `"./fsrs"`):

```ts
describe("parseDateOrNull (DB timestamps are UTC)", () => {
  test("treats zone-less DB timestamps as UTC, not server-local", () => {
    expect(parseDateOrNull("2026-11-09 16:00:00")?.toISOString()).toBe(
      "2026-11-09T16:00:00.000Z"
    );
  });

  test("parses values with an explicit zone unchanged", () => {
    expect(parseDateOrNull("2026-11-09T16:00:00.000Z")?.toISOString()).toBe(
      "2026-11-09T16:00:00.000Z"
    );
    expect(parseDateOrNull("2026-11-09T16:00:00+08:00")?.toISOString()).toBe(
      "2026-11-09T08:00:00.000Z"
    );
  });

  test("returns null for null/undefined/garbage", () => {
    expect(parseDateOrNull(null)).toBeNull();
    expect(parseDateOrNull(undefined)).toBeNull();
    expect(parseDateOrNull("not a date")).toBeNull();
  });
});

describe("seedFsrsStateFromSm2 (UTC seeding)", () => {
  test("seeds due/lastReview from zone-less DB timestamps as UTC", () => {
    const state = seedFsrsStateFromSm2({
      easeFactor: 2.5,
      interval: 6,
      repetitions: 2,
      nextReviewDate: "2026-11-09 16:00:00",
      lastReviewed: "2026-11-03 16:00:00",
    });
    expect(state.due.toISOString()).toBe("2026-11-09T16:00:00.000Z");
    expect(state.lastReview?.toISOString()).toBe("2026-11-03T16:00:00.000Z");
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run with a non-UTC TZ so the bug is deterministic on any machine:
`TZ=Asia/Hong_Kong bun test lib/srs/fsrs.test.ts`
Expected: FAIL — `"2026-11-09 16:00:00"` is parsed as 16:00 *HKT* (= 08:00 UTC), so `toISOString()` yields `"2026-11-09T08:00:00.000Z"`. Also FAILS to compile: `parseDateOrNull` is not exported.

- [x] **Step 3: Implement in `lib/srs/fsrs.ts`**

Replace `parseDateOrNull`:

```ts
function parseDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
```

with:

```ts
/** DB DATETIME columns hold UTC without a zone marker ("YYYY-MM-DD HH:MM:SS").
 * `new Date(...)` reads such strings as server-LOCAL time, which would shift
 * every stored instant on non-UTC servers, so normalize them to ISO UTC
 * first. Strings that already carry a zone (ISO snapshots) parse as-is. */
const ZONELESS_DB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function parseDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  const normalized = ZONELESS_DB_TIMESTAMP.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
```

In `seedFsrsStateFromSm2`, replace:

```ts
    return cardToState(
      createEmptyCard(nextReviewDate ? new Date(nextReviewDate) : new Date())
    );
```

with:

```ts
    return cardToState(
      createEmptyCard(parseDateOrNull(nextReviewDate) ?? new Date())
    );
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `TZ=Asia/Hong_Kong bun test lib/srs/fsrs.test.ts`
Expected: PASS — all existing tests plus the 4 new ones.

- [x] **Step 5: Commit**

```bash
git add lib/srs/fsrs.ts lib/srs/fsrs.test.ts
git commit -m "fix: parse zone-less DB timestamps as UTC in FSRS seeding"
```

---

### Task 4: Wire the client timezone through the review POST

**Files:**
- Modify: `app/api/reviews/route.ts` (imports ~line 7; POST body read ~line 226; SM-2 call ~line 319)
- Modify: `components/ReviewSession.tsx` (`handleRate` fetch, lines ~643-647)

- [x] **Step 1: Server — read and validate `timezone` from the POST body**

In `app/api/reviews/route.ts`, add to the imports:

```ts
import { resolveClientTimezone } from "@/lib/timezone";
```

Change the body destructure in `POST`:

```ts
      const { wordId, rating } = await request.json();
```

to:

```ts
      const { wordId, rating, timezone } = await request.json();
```

Immediately after the `ratingName` validation block (`if (!ratingName) { ... }`), add:

```ts
      // The user's device timezone decides the local-midnight boundary for
      // the next review. Invalid/absent values fall back to the legacy
      // server-local behavior so old cached clients keep working.
      const clientTimezone = resolveClientTimezone(timezone) ?? undefined;
```

Pass it into the SM-2 scheduling call:

```ts
      const result = sm2Algorithm({
        easeFactor: inputReview.easeFactor,
        interval: inputReview.interval,
        repetitions: inputReview.repetitions,
        rating: parseRating(ratingName),
        timezone: clientTimezone,
      });
```

Do NOT touch the FSRS branch — `scheduleWithFsrs` stays instant-based by design.

- [x] **Step 2: Client — send the browser timezone with each rating**

In `components/ReviewSession.tsx`, `handleRate`, change the fetch body:

```ts
        body: JSON.stringify({ wordId: currentReview.wordId, rating }),
```

to:

```ts
        body: JSON.stringify({
          wordId: currentReview.wordId,
          rating,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
```

- [x] **Step 3: Typecheck and lint**

Run: `bunx tsc --noEmit`
Expected: no errors.

Run: `bun run lint`
Expected: passes (no new warnings).

- [x] **Step 4: Run the full unit suite**

Run: `TZ=Asia/Hong_Kong bun test lib/timezone.test.ts lib/srs/sm2.test.ts lib/srs/fsrs.test.ts`
Expected: PASS — all tests.

- [x] **Step 5: Commit**

```bash
git add app/api/reviews/route.ts components/ReviewSession.tsx
git commit -m "feat: send client timezone with review submissions"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only)

- [x] **Step 1: Start the dev server on the Playwright port**

Run in background: `bun run dev -- --port 3001`
Expected: server ready on `http://localhost:3001`. (Check `playwright.config.ts` baseURL first — it expects `http://localhost:3001`.)

- [x] **Step 2: Run the review E2E suites**

Run: `bunx playwright test tests/e2e/review-queue.spec.ts tests/e2e/review-history.spec.ts`
Expected: PASS — these suites POST `/api/reviews` without a timezone, exercising the fallback path.

- [x] **Step 3: Manual DB sanity check (optional but recommended)**

With a logged-in browser session, rate a word with `good` and confirm in the DB that `next_review_date` is the UTC instant of *your* local midnight tomorrow (e.g. for `Asia/Hong_Kong`, `YYYY-MM-DD 16:00:00` of today's date):

```bash
sqlite3 data/vocleap.db "SELECT word_id, next_review_date FROM reviews ORDER BY updated_at DESC LIMIT 5;"
```

Expected: the newest row's `next_review_date` equals local-midnight-tomorrow expressed in UTC.

- [x] **Step 4: Stop the dev server**

Kill the background `bun run dev` process.

---

## Self-review notes

- **Spec coverage:** write-side boundary (Tasks 1+2), client→server transport (Task 4), FSRS UTC parse (Task 3), query-side unchanged (by design, verified in Task 5), fallback behavior (Tasks 2+4 tests), unit + e2e verification (Tasks 1-5). ✓
- **Placeholders:** none — every step has full code or an exact command. ✓
- **Type consistency:** `resolveClientTimezone(unknown) -> string | null`, `addCalendarDaysInZone(string, Date, number) -> Date`, `SM2Input.timezone?: string` / `now?: Date` used consistently across tasks. ✓

## Execution outcome (2026-11-09)

- All tasks implemented and committed on `develop` (cf1d3c1, a6765af, 234b566, c2dbffb).
- Unit: 28/28 pass (`TZ=Asia/Hong_Kong bun test lib/timezone.test.ts lib/srs/sm2.test.ts lib/srs/fsrs.test.ts`). Typecheck clean. ESLint clean on all touched files (repo-wide lint failures pre-date this work).
- E2E: `review-history` and 1/3 of `review-queue` pass. The 2 failing `review-queue` tests ("reloading mid-session resumes…", "finishing a session does not resurrect…") were verified to fail identically on the pre-change commit `73413a3` (worktree run) — **pre-existing review-session restore bug, unrelated to this work**.
