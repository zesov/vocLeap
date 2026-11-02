# Changelog

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

