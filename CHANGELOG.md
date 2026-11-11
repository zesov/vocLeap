# Changelog

All notable changes to **Vocleap** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.8.0] - 2026-11-11

### Added
- **UUID backfill migration** — `ensureSchema` now assigns v4 UUIDs to legacy `words` / `review_history` rows that predate the uuid columns (idempotent `UPDATE … WHERE uuid IS NULL`, one atomic batch); `bun run migrate` converges local SQLite and Turso. Fixes sync pull returning nothing for pre-sync data
- **Words page stability** — Infinite scroll got a visible "Load More" fallback button and a properly sized scroll sentinel; the remote→local database transition now swaps data silently (request-sequence guard prevents out-of-order responses from blanking the grid)
- **Unit test relocation** — All `*.test.ts` files consolidated under `tests/unit/` mirroring `lib/` structure; `tsconfig` excludes them from the app build

### Changed
- **Proxy-aware dev tooling** — `dev` / `build` / `start` / `migrate` / backfill scripts run with `NODE_USE_ENV_PROXY=1` so Node's fetch honours `HTTP_PROXY`/`HTTPS_PROXY` in proxied environments (no-op where no proxy vars are set, e.g. Vercel)

### Fixed
- **PWA install prompt** — Eliminated render-time `setTimeout(setState)`; hint state is only scheduled from effects, silencing the "state update on a component that hasn't mounted yet" console error
- **Local database resilience** — OPFS availability probed via `installOpfsSAHPoolVfs` (release builds strip `sqlite3.opfs`); wa-sqlite IndexedDB engine skipped with a clear message when the Web Locks API is unavailable (private browsing); fatal storage errors (disk I/O, corruption, quota) tear down the local handle and fall back to the server API instead of failing every read
- **Sync bootstrap ordering** — The first pull runs before the local database is published to components, so the words/review pages never render an empty offline file; `saveWord` triggers an immediate sync
- **Sync server IDs** — `serverId` flows through pull/merge and backfills existing rows, fixing `FOREIGN KEY constraint failed` and duplicate-key warnings on queued ops

## [0.7.1] - 2026-11-10

### Added
- **Release automation script** (`scripts/release.ts`) — Auto-bump version with `--patch`, `--minor`, `--major` flags, explicit version support, dry-run preview, updates CHANGELOG.md and package.json, creates annotated git tags and GitHub Releases
- **License compliance documentation** — Added `LICENSES.md` with full third-party license audit; README links to it for LGPL-3.0-or-later (`sharp`) transparency

### Changed
- **Build config** — Excluded `scripts/` from TypeScript compilation to avoid Bun API type errors in release script

### Fixed
- **TypeScript build** — Release script no longer blocks production type-check

## [0.7.0] - 2026-11-10

### Added
- **Review session progress fix** — Top bar now shows page counter (`Card X / Y`) matching pagination, progress percentage calculates from current page position, card title retains session-based counter
- **Explicit schema migrations** — `bun run migrate` applies idempotent migrations (one inspect + one atomic batch) for both local SQLite and Turso; local mode still auto-converges on dev
- **Region colocation** — Vercel functions pinned to `sin1` (Singapore) to colocate with Turso (`aws-ap-southeast-1`), dropping per-query latency from ~250 ms to single-digit ms
- **Single-query stats** — `getReviewStats` now computes due/total/new in one query with subqueries (was 3 round trips)

### Changed
- Schema migration moved out of cold-start path: `lib/db/init.ts` is now a thin singleton; Turso mode pays zero DB round trips on cold start
- DB adapter split: `lib/db/schema.ts` (DDL + `ensureSchema`), `lib/db/adapter.ts` (backends + `createAdapter`), lazy `better-sqlite3` import so Turso builds never bundle native module
- `vercel.json` function region pinned to `sin1`

### Fixed
- Cold-start latency spikes (5.9–8.6 s → tens of ms) caused by 19 sequential schema DDL/PRAGMA round trips across the Pacific

---

## [0.6.0] - 2026-11-07

### Added
- **Switchable SRS algorithm** — Per-user choice between SM-2 (default) and FSRS via NavBar toggle, persisted in `users.srs_algorithm`
- **FSRS support** — Powered by `ts-fsrs` v6 with day-granular scheduling (short-term steps disabled); state stored in new `reviews` columns (`stability`, `difficulty`, `fsrs_state`, `lapses`, `reps`)
- **Interval preview** — Rating buttons show server-computed intervals (`GET /api/reviews?action=intervals`) for the active algorithm
- **Algorithm-aware history** — `review_history` records algorithm per entry + before/after FSRS snapshot; history table renders `S …/D …` memory state for FSRS rows

### Changed
- Non-destructive switching: first FSRS review seeds from SM-2 state (interval → stability @ 0.9 retention, ease factor → difficulty via fsrs4anki conversion); switching back resumes frozen SM-2 columns
- Mobile rating menu replaced native `<select>` with segmented control (fixes dropdown mispositioning)
- Startup migration adds all FSRS columns idempotently on both backends

---

## [0.5.0] - 2026-11-06

### Added
- **Fast page navigation** — NavBar rendered from route-group layouts (`(public)` / `(app)`), persists across client-side navigations without remount
- **Auth caching** — 5-minute `vocleap_session_cache` cookie; `getCurrentUser()` serves cached user before querying sessions table

### Changed
- Removed per-navigation `/api/auth/me` fetch from NavBar (was double auth check on every route change)
- Public pages (home, dictionary, login, signup) moved into `(public)` route group with shared layout; protected pages stay in `(app)`

### Fixed
- `getCurrentUser()` keeps `await connection()` — session expiry checks must render at request time to avoid `blocking-prerender-current-time`

---

## [0.4.0] - 2026-11-05

### Added
- **Phonetic display on Words page** — Each card shows phonetic under the word; bare Google Translate phonetics wrapped as `/…/`, Wiktionary phonetics shown as-is
- **Review history pagination** — `GET /api/reviews?action=history` accepts `limit`/`offset`, returns `{ history, total, limit, offset, hasMore }`; infinite scroll loads 30 entries at a time
- **Words sorting** — `GET /api/words` accepts `sort=date_desc|date_asc|alpha_asc|alpha_desc`; Words page has Sort by control with custom dropdown (keyboard accessible, mobile-friendly)
- **Review interval preview** — Rating buttons show scheduled interval before commit; card footer shows `Last interval` instead of misleading `Next review in`
- **E2E coverage** — Phonetic display, history paging, words sorting

### Changed
- `review_history(reviewed_at DESC, id DESC)` index for stable paging when rows share timestamp
- `formatInterval()` pluralisation fixed (`1 week`, `1 month`, `1 year`)

---

## [0.3.0] - 2026-11-04

### Added
- **Review queue semantics** — `GET /api/reviews?action=all` now applies same filter as `review`/`new` (due only / never-reviewed only); queue loads for current mode, synced positions only restore ordering
- **Resume position by reviewed count** — "Card X of Y" stays correct when reviewed words drop out of queue
- **Session completion resets progress** — Clearing review state also clears session meta; finished sessions reset instead of inheriting stale count

### Fixed
- Merged positions now respect position `0`
- Completed cards no longer re-queued on reload
- Synced positions rebased to current queue (payload bounded by session size)

---

## [0.2.0] - 2026-11-03

### Added
- **Multi-user accounts** — Email/password with scrypt-hashed passwords, HttpOnly/SameSite=Lax session cookies stored as SHA-256 hashes
- **Auth endpoints** — `/login`, `/signup`, `/api/auth/{signup,login,logout,me}`; NavBar shows signed-in email + sign-out
- **Data isolation** — `words.user_id` with `UNIQUE(user_id, word)`; `reviews` and `review_history` isolated via words join
- **Protected routes** — `/review`, `/words`, `/review-history` and words/reviews APIs require session; `/dictionary` stays public (prompts sign-in on save)
- **Migration tooling** — `bun run migrate:multiuser` (idempotent, rebuilds `words` atomically), `bun run claim-owner` for manual recovery; first `OWNER_EMAIL` account claims pre-existing data
- **Playwright isolation** — Tests run on dedicated port + test database; auth/isolation E2E coverage

### Fixed
- Sign-in no longer fails when browser autofills before hydration (uncontrolled inputs + FormData submission)
- Successful auth performs full navigation to `next`, guaranteeing fresh session cookie seen by proxy/layout
- Signed-in visitors to `/login` or `/signup` redirected to `next` (default `/review`)
- `POST /api/review-state` batches positions into one multi-row UPSERT (50-word sync: ~5.7 s → ~200 ms)
- Centralised `safeNext()` validation + `SESSION_COOKIE` constant

---

## [0.1.0] - 2026-11-02

### Added
- **Dual SQLite backend** — `DB_MODE=local` (better-sqlite3) or `turso` (@libsql/client) via unified async `DatabaseAdapter`; Turso URL defaults to `libsql://your-database-your-org.turso.io`
- **Wiktionary dictionary** — Multilingual lookup (EN, ZH, JA, KO, FR, DE, ES, RU) at `/dictionary` with translations, definitions, examples, phonetics
- **SM-2 spaced repetition** — Save words, review at `/review` with Again/Hard/Good/Easy ratings
- **Next.js PWA** — Service worker, offline support, install prompt via `next-pwa`
- **Full API layer** — REST endpoints for translate, words, reviews
- **Component library** — Button, Input, Select, Card primitives
- **Complete navigation** — Dictionary, Review, Words, History pages
- **Offline functionality** — Works without network via service worker caching
- **Import from Google Translate** — Tab-separated, JSON, or colon-separated formats
- **E2E tests** — Playwright specs for dictionary, review, auth flows

### Changed
- Translation source: Google Translate API → Wiktionary API with retry logic (3 attempts, exponential backoff)
- Words page: fixed `JSON.parse()` on `definitions`, added "← Home" link
- Shared `NavBar` component across all pages with consistent heading styling

### Fixed
- TypeScript build errors on Vercel (typed row interfaces, `InValue[]` args, `bigint` → `number` coercion, ambient `next-pwa` types)
- `@types/better-sqlite3` added as devDependency
- `themeColor` moved from `metadata` to `viewport` export, eliminated build warnings

---

## [0.0.5] - 2026-11-02

### Added
- **Review history page** — `/review-history` shows full SM-2 history: word, translation, rating, ease factor change, interval, repetitions, reviewed at
- **History API** — `GET /api/reviews?action=history` returns all history joined with word/translation via `getAllReviewHistory()`
- **NavBar "History" item** — Vocleap logo now links to `/`

### Fixed
- `GET /api/reviews?action=history&wordId=X` route ordering (history branch now reachable before generic wordId branch)
- Review submission: `getReview()` maps snake_case DB columns (`word_id`, `ease_factor`, …) to camelCase
- Keyboard shortcuts on `/review`: Space toggles Show Answer; 1–4 rate Again/Hard/Good/Easy when answer shown
- `/api/reviews?action=review` endpoint handling
- Auto-switch logic: removed premature `sessionComplete=true` when switching review → new words

---

## [0.0.4] - 2026-11-02

### Fixed
- **New words queue** — Saving/importing no longer creates placeholder `reviews` row; `stats.newWords` now correct, never-reviewed words no longer counted as due
- `GET /api/reviews?action=all&mode=new` includes never-reviewed words for cross-device restore
- `stats.total` counts saved words (not review rows)
- Review page decrements `newWords` immediately after rating in New Words mode
- `bun run reset:unreviewed` deletes placeholder review rows (`last_reviewed IS NULL`, no history) from earlier versions
- Cross-device sync E2E tests updated for new-word queue semantics

---

## [0.0.3] - 2026-11-02

### Added
- **Sign-in redirect** — Signed-out visits to protected routes redirect to `/login?next=<path>`; signing in returns to requested page
- **Optimistic auth gate** — `proxy.ts` + protected layout server-side validation
- **E2E coverage** — Redirect after sign-in

### Fixed
- `/signup` honours `next`; login/signup switch links preserve destination

---

## [0.0.2] - 2024-11-02

### Added
- Initial Vocleap Next.js PWA release
- Wiktionary dictionary lookup with multilingual support
- SM-2 spaced repetition review system
- SQLite storage with better-sqlite3
- PWA with service worker, offline support, install prompt
- Full REST API layer (translate, words, reviews)
- Component library (Button, Input, Select, Card)
- Complete navigation (Dictionary, Review, Words pages)
- Offline-first design with IndexedDB fallback
- Responsive design with dark mode
- Playwright E2E test configuration
- Import from Google Translate (tab-separated, JSON, colon-separated)

---

## Legend

| Type | Emoji | Description |
|------|-------|-------------|
| Added | ✨ | New features |
| Changed | 🔄 | Changes in existing functionality |
| Deprecated | ⚠️ | Soon-to-be removed features |
| Removed | 🗑️ | Removed features |
| Fixed | 🐛 | Bug fixes |
| Security | 🔒 | Vulnerability fixes |