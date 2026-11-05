# Changelog

All notable changes to risk-frontend are documented in this file.

## Unreleased

### Android (Tauri v2)
- Added Tauri v2 project (`src-tauri/`) with Android target (`aarch64-linux-android`)
- Configured `tauri.conf.json` (`identifier: com.vocleap.app`, `frontendDist: ../frontend-dist`)
- Set up `.cargo/config.toml` with NDK linker (`aarch64-linux-android34-clang`)
- Added release APK signing via `cargo-apk` (debug keystore, `keystore_password = "android"`)
- Built `target/release/apk/app_lib.apk` (arm64-v8a, ~3 MB)
- `.gitignore` extended: `src-tauri/target/`, `frontend-dist/`, `.Android/`, `local.properties`, `gradle/`

## [2026-11-05] Review History Pagination & Words Sorting
- `GET /api/reviews?action=history` now accepts `limit`/`offset` and returns `{ history, total, limit, offset, hasMore }` instead of every record
- Review history page loads 30 entries at a time as the table scrolls, with a retry state on failure
- Added a `review_history(reviewed_at DESC, id DESC)` index so history paging stays stable when rows share a timestamp
- `GET /api/words` accepts `sort=date_desc|date_asc|alpha_asc|alpha_desc` (default `date_desc`) and falls back safely for unknown values
- Words page has a Sort by control (Newest first, Oldest first, A–Z, Z–A); changing it resets the paginated list
- Refined the Sort by dropdown: 40px height aligned with Import Words, sort icon, custom chevron, and full-width stacking on mobile
- Added E2E coverage for history paging and words sorting

## [2026-11-05] Review Interval Preview
- Rating buttons now show the interval each rating would schedule, calculated from the card's current SM-2 state before rating
- Keep the rating-button spinner centered and the button height stable while a review is submitting
- The card footer now shows `Last interval` instead of the misleading `Next review in`
- Fixed `formatInterval()` pluralisation (`1 week`, `1 month`, `1 year`)
- Review E2E coverage still passes

## [2026-11-05] Review-state Payload & Request Dedupe
- `GET /api/review-state?allDevices=true` now returns the latest state per word across devices instead of every row; a real account dropped from 1,950 to 297 review states (~220 KB → ~34 KB)
- Cross-device session meta is fetched in one query instead of one query per device
- `POST /api/review-state` now replaces the device's saved slice and prunes words that left the queue, so `user_review_state` stops growing with every session
- Removed redundant `/api/auth/me` preflight calls from the review session; the protected layout enforces auth and review submission handles a 401 directly
- Fixed the initial sync effect double-fetching `/api/reviews` when the 3s fallback fired and `synced` then flipped to true
- Review sync E2E coverage still passes (queue semantics and cross-device resume)

## [2026-11-04] Review Queue Semantics
- `GET /api/reviews?action=all` now applies the same filter as `review`/`new` (due words only, or never-reviewed words only) instead of returning every word
- The review page always loads the queue for the current mode and only uses synced positions to restore ordering, so completed cards are no longer re-queued on reload
- Resume position is tracked by the reviewed count, keeping "Card X of Y" correct when reviewed words drop out of the queue
- Synced positions are rebased to the current queue, keeping the `review-state` payload bounded by session size
- Clearing review state now also clears the session meta, and finishing a session resets progress instead of inheriting a stale count
- Fixed merged positions ignoring position `0`
- Added E2E coverage for queue filtering, mid-session reload, and finished sessions

## [2026-11-04] Sign-in Navigation & Review-state Sync
- Sign-in no longer silently fails when a browser fills credentials before React hydrates: auth inputs are uncontrolled and submission reads `FormData`, so typed values are never reset to empty
- Successful sign-in/sign-up now performs a full navigation to `next`, guaranteeing the fresh session cookie is seen by the proxy and protected layout
- Signed-in visitors to `/login` or `/signup` are redirected to `next` (default `/review`) instead of being shown the form again
- The auth form falls back to a POST of the current URL before hydration, so credentials never end up in the query string
- `POST /api/review-state` batches positions into one multi-row UPSERT: a 50-word sync against Turso drops from ~5.7s to ~200ms
- Review session checks `/api/auth/me` before fetching and falls back to a UUID v4 generator when `crypto.randomUUID()` is unavailable
- Skipped the CSRF origin check in development and removed a duplicated `initDatabase` import in the review-state route

## [2026-11-03] Sign-in Redirect
- Signed-out visits to `/review`, `/review-history`, or `/words` now redirect to `/login?next=<path+query>`, and signing in returns to the requested page
- Added `proxy.ts` as an optimistic auth gate; the protected layout still validates the session server-side
- `/signup` now honours `next`, and the login/signup switch links preserve the destination
- Centralised `safeNext()` validation (rejects protocol-relative and backslash paths) and the `SESSION_COOKIE` constant
- Added E2E coverage for redirecting back after sign-in

## [2026-11-03] New Words Queue Fix
- Saving or importing a word no longer creates a placeholder `reviews` row, so `GET /api/reviews?action=stats` reports `newWords` correctly and never-reviewed words are no longer counted as due
- `GET /api/reviews?action=all&mode=new` now includes never-reviewed words so the new-word queue can be restored across devices
- `stats.total` now counts saved words instead of review rows
- Review page decrements `newWords` immediately after rating a card in New Words mode
- Added `bun run reset:unreviewed` to delete placeholder review rows (`last_reviewed IS NULL`, no history) left by earlier versions; run once on existing databases
- Updated cross-device sync E2E tests for the new-word queue semantics

## [2026-11-03] Multi-user Accounts
- Added email + password accounts with server-side sessions (`users`, `sessions`); passwords use Node scrypt, session cookies are HttpOnly/SameSite=Lax and stored as SHA-256 hashes
- Added `/login`, `/signup`, `/api/auth/{signup,login,logout,me}`; NavBar shows the signed-in email and a sign-out action
- `words` now belongs to a user (`words.user_id`, `UNIQUE(user_id, word)`); `reviews` and `review_history` are isolated through a `words` join
- `/review`, `/words`, `/review-history` and the words/reviews APIs require a session; `/dictionary` stays public and prompts sign-in on save
- Added `bun run migrate:multiuser` (idempotent, local + Turso, rebuilds `words` atomically without disabling foreign keys) and `bun run claim-owner` for manual recovery
- The first account with `OWNER_EMAIL` claims all pre-existing words and review history
- Playwright now runs on its own port and test database; added auth/isolation E2E coverage and fixed the stale dictionary spec

## [2024-11-02] Vocleap Next.js PWA

### Added
- **Wiktionary Dictionary** - Word lookup with translations, definitions, examples, and phonetics from Wiktionary (multilingual: EN, ZH, JA, KO, FR, DE, ES, RU) at `/dictionary`
- **Spaced Repetition System (SM-2)** - Save words and review them using the SuperMemo-2 algorithm at `/review`
- **SQLite Storage** - Persistent local storage with better-sqlite3 for words and review data
- **Next.js PWA** - Progressive Web App capabilities with service worker, offline support, and install prompt
- **Full API Layer** - REST APIs for translate, words management, and reviews
- **Component Library** - UI components including Button, Input, Select, and Card
- **Complete Navigation** - Main pages for dictionary, review, and word management
- **Offline Functionality** - Works without network via service worker caching
- **E2E Tests** - Playwright tests for dictionary lookup functionality
- **Import from Google Translate** - Import saved translations into `/words` via tab-separated, JSON, or colon-separated text formats

### Changed
- **Translation source** - Replaced Google Translate API with Wiktionary API (`lib/dictionary/wiktionaryApi.ts`) for reliable multilingual dictionary lookups
- **Translation route** - `app/api/translate/route.ts` now queries Wiktionary with retry logic (3 attempts, exponential backoff) for rate limit resilience
- **Words page** - Fixed `JSON.parse()` bug on `definitions` field, added "← Home" link
- **Shared navigation** - Extracted nav header into `components/NavBar.tsx`, used across home, dictionary, review, and words pages for consistent UI
- **Page titles** - Page titles rendered through `NavBar` title prop for consistent heading styling

### Technical Details
- Built with Next.js 16.4.3, React 19, Tailwind CSS 4
- Dependencies: next-pwa, better-sqlite3, idb, TypeScript
- Wiktionary-based dictionary API with CJK translation extraction
- SM-2 spaced repetition algorithm for optimal vocabulary retention
- Offline-first design with IndexedDB fallback
- Responsive design with dark mode support
- Playwright E2E test configuration

### Features
- Look up words with Wiktionary API (multilingual dictionary)
- Save words for spaced repetition review
- Review saved words with SM-2 algorithm (Again/Hard/Good/Easy ratings)
- Works offline as a PWA
- Install to home screen for mobile access
- Persistent storage with SQLite
- E2E testing with Playwright

All features work end-to-end: lookup word → save to SQLite → review via SRS → works offline via PWA.

## [2026-11-02] Review Page Fix
- Fixed `/api/reviews?action=review` endpoint to handle review mode
- Fixed ReviewSession auto-switch logic: removed premature `sessionComplete=true` when switching from review to new words mode
- Review page now correctly displays new words (2008 imported words) when no due reviews exist

## [2026-11-02] Review Submission + Keyboard Shortcuts
- Fixed `Failed to submit review` error: `getReview()` now maps snake_case DB columns (`word_id`, `ease_factor`, ...) to camelCase so existing review rows submit correctly via the SM-2 POST endpoint
- Added keyboard shortcuts on `/review`: Space toggles Show Answer; 1–4 rate Again/Hard/Good/Easy when the answer is shown

## [2026-11-02] Review History API
- Fixed `GET /api/reviews?action=history&wordId=X` returning "Invalid action": reordered route checks so the history branch is reachable before the generic wordId branch
- Review history data is now accessible per word via the API

## [2026-11-02] Review History Page
- Added `/review-history` page showing full SM-2 review history: word, translation, rating, ease factor change, interval, repetitions, and reviewed at
- `GET /api/reviews?action=history` returns all history joined with word/translation via new `getAllReviewHistory()`
- NavBar: added "History" nav item; Vocleap logo now links to `/`

## [2026-11-02] Dual SQLite Backend (local / Turso)
- Refactored `lib/db/` to support both local SQLite (`better-sqlite3`) and remote Turso (`@libsql/client`, libsql://)
- Select backend via `DB_MODE` env var: `local` (default) or `turso`
- Turso URL defaults to `libsql://vocleap-vocleap.aws-ap-southeast-1.turso.io`, overridable via `TURSO_URL`; auth via `TURSO_AUTH_TOKEN`
- All DB operations are now async through a unified `DatabaseAdapter` interface

## [2026-11-02] Build Type-Check Fixes
- Fixed TypeScript errors that failed `next build` on Vercel
- `lib/db/operations.ts`: introduced typed row interfaces and map snake_case columns to the camelCase `Word` model in word queries
- `lib/db/init.ts`: typed Turso statement args as `InValue[]` and coerced `lastInsertRowid` from `bigint` to `number`
- `app/api/words/route.ts`: removed invalid `lastReviewed: null` values and guarded against a null created word
- `components/ui/Card.tsx`: added the `destructive` variant already used by the words import result card
- `next-pwa.d.ts`: added ambient module types for `next-pwa`; removed the `as any` cast in `next.config.ts`

## [2026-11-02] Vercel Build: Types and Viewport Metadata
- Added `@types/better-sqlite3` as a devDependency so `next build` type-check no longer fails with `TS7016: Could not find a declaration file for module 'better-sqlite3'`
- Refreshed `package-lock.json` (it was missing the `@libsql/*` tree) and `bun.lock` so installs are reproducible
- `tsconfig.json`: limited implicit ambient types to `["node"]`, preventing the deprecated `@types/minimatch` stub from failing `tsc` with `TS2688`
- `app/layout.tsx`: moved `themeColor` from `metadata` to the `viewport` export and dropped the duplicate manual `<meta name="theme-color">`; eliminates the per-route `Unsupported metadata themeColor` build warnings

## [2026-11-03] Review Real-Time Feedback
- "Due Now" stat on `/review` now decrements immediately after rating a card in review mode, instead of waiting for a refetch
- Rating buttons now show the loading spinner only on the clicked Again/Hard/Good/Easy button; all four stay disabled during submission to prevent double submits

## [2026-11-03] Mobile Navigation and Responsive Padding
- `components/NavBar.tsx`: responsive header — inline nav links on `md+`, hamburger toggle with animated 2×2 link panel below `md`
- Mobile menu closes on route change, Escape, or link tap; links use 44px touch targets and `aria-current` for the active page
- Header is now sticky; nav horizontal padding matches page content (`px-4 sm:px-6`) so edges align on desktop
- Added consistent content padding across `/`, `/dictionary`, `/review`, `/review-history`, and `/words`: `px-4 sm:px-6` with `py-6 sm:py-8` (home uses `py-8 sm:py-12`), so content no longer touches screen edges on mobile

## [2026-11-03] Review Card Dictionary Shortcut
- Added an info icon at the top-right of the reviewed word; tapping it opens `/dictionary?word=<word>` and runs the lookup automatically
- `app/dictionary/page.tsx`: reads the `word` search param inside a `<Suspense>` boundary so the route keeps a static shell and no longer triggers Next 16's `blocking-prerender-runtime`
- `components/DictionaryLookup.tsx`: accepts an `initialWord` prop, auto-looks it up once, and reuses a shared `lookupWord()` for form submissions
- `components/ReviewSession.tsx`: icon is a 44px `Link` and does not trigger the mobile tap-to-toggle answer

## [2026-11-03] Review Session Resume Position
- `/review` now remembers the current card across refreshes, with independent progress for Review and New Words modes
- Progress is stored in `localStorage` as `{ wordId, position }`; after refetch, the card is restored by `wordId` and the cumulative counter stays accurate (e.g. "Review 11 of 50" instead of resetting to 1)
- Saved progress is cleared when the session completes or the queue is empty; stale `wordId`, invalid JSON, and unavailable storage fall back safely

