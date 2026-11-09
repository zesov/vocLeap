# Due-date timezone handling

Date: 2026-11-09
Status: Approved

## Problem

- `reviews.next_review_date` is stored as a UTC string (`YYYY-MM-DD HH:MM:SS`, written by `formatDateForDB` / `toISOString`).
- Due queries compare it against SQLite `datetime('now')` (also UTC), so the **comparison side is already consistent** — UTC instant vs UTC instant.
- The real bug is on the **write side**: `sm2Algorithm` computes the "next day at midnight" boundary with server-local operations (`setDate()`, `setHours(0, 0, 0, 0)`). For a user whose timezone differs from the server's:
  - a word scheduled for "tomorrow" becomes due at the wrong absolute instant (e.g. 08:00 HKT instead of 00:00 HKT when the server runs UTC);
  - a review submitted shortly after the user's local midnight can even land on the wrong calendar day ("today" is still yesterday in server time).
- Secondary bug: `lib/srs/fsrs.ts` parses zone-less DB timestamps with `new Date("YYYY-MM-DD HH:MM:SS")`, which V8 interprets as **server-local** time, shifting FSRS seed state (`due`/`lastReview`) on non-UTC servers.

## Decisions

- **FSRS stays instant-based** (due = review moment + N days; no midnight alignment). Confirmed with user.
- **Timezone source**: the browser's current IANA timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`), sent per review submission. **Not** stored in the users table.
- **DB stays UTC.** Conversion happens at write time: user-local midnight → the corresponding UTC instant. Once writes are correct, the existing `datetime('now')` comparisons are correct without any SQL change.
- **Fallback**: a missing or invalid `timezone` keeps today's behavior (server-local boundary), so old cached clients and existing E2E tests are unaffected.

## Changes

1. **`lib/timezone.ts` (new)** — pure `Intl`-based helpers, no dependencies:
   - `resolveClientTimezone(input: unknown): string | null` — validates the client-supplied string is a supported IANA zone (try/catch around `Intl.DateTimeFormat`).
   - `addCalendarDaysInZone(timeZone, date, days): Date` — the UTC instant of local-midnight on the calendar date `days` after `date`'s local date in `timeZone` (via `formatToParts` + double offset correction, DST-safe).
2. **`lib/srs/sm2.ts`** — `SM2Input` gains optional `timezone?: string` and `now?: Date`. With a timezone, `nextReviewDate = addCalendarDaysInZone(timezone, now, newInterval)`; without one, behavior is unchanged (server-local).
3. **`app/api/reviews/route.ts` (POST)** — read `timezone` from the body, validate, pass into the SM-2 scheduling call. FSRS path untouched.
4. **`components/ReviewSession.tsx`** — `handleRate` includes `timezone` in the POST body.
5. **`lib/srs/fsrs.ts`** — `parseDateOrNull` treats `YYYY-MM-DD HH:MM:SS` (no zone marker) as UTC by appending `Z`; strings already carrying `Z`/offset parse as before. `seedFsrsStateFromSm2` reuses the same helper for `nextReviewDate`.

## Out of scope

- Historical rows written under the server's timezone: no migration; each word self-corrects at its next review.
- Query-side SQL: unchanged (`datetime('now')` vs UTC storage is already correct).

## Testing

- New unit tests under `tests/unit/` (bun test): boundary math with a fixed `now` (e.g. `Asia/Hong_Kong` → stored UTC value equals local midnight), invalid-timezone fallback, zone-less timestamp parsing as UTC.
- `bunx tsc --noEmit`, `bun run lint`, existing Playwright E2E suite.
