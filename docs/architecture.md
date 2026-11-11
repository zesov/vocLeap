# Architecture

A map of how Vocleap is put together. File paths are relative to the repo root.

## Overview

Vocleap is a multi-user vocabulary SRS app built on Next.js 16 (App Router,
Turbopack) with React 19 and Tailwind CSS 4. Two route groups split the app:

- `app/(public)/` — home, dictionary lookup, login, signup
- `app/(app)/` — review, word list, review history (session required)

Deployed to Vercel; `vercel.json` pins functions to `sin1` to colocate with the
Turso database (SQL statements are network round trips — region colocation is
the dominant latency factor).

## Data layer (`lib/db/`)

**Dual-backend adapter** (`adapter.ts`). A single `DatabaseAdapter` interface
(`exec`, `batch`, `transaction`, async prepared statements) is implemented by:

- `LocalAdapter` — `better-sqlite3` at `DB_PATH` (default `./data/vocleap.db`),
  WAL mode, foreign keys on. The native module is imported **lazily** so Turso
  deployments never bundle or dlopen it.
- `TursoAdapter` — `@libsql/client` against `TURSO_URL` + `TURSO_AUTH_TOKEN`.
  Batches are atomic writes; there is no interactive transaction.

`DB_MODE` (`local` default) selects the backend. `db` is a module singleton
created at import time (`init.ts`).

**Schema convergence** (`schema.ts`). `ensureSchema()` reads ~20 flags (tables,
columns, indexes) in **one** inspect query. If the schema is current it does
nothing; otherwise it runs the base `CREATE TABLE IF NOT EXISTS` DDL plus only
the missing `ALTER TABLE`/index statements as a single atomic batch.

**When it runs** (`init.ts`):

- Local mode: converged once per process, automatically — keeps `next dev`
  zero-setup.
- Turso mode: a deliberate **no-op**. Migrations are explicit
  (`bun run migrate` → `scripts/migrate.ts`) so a serverless cold start pays
  zero schema-check round trips. Forgetting to migrate fails loudly with
  `no such table`.

**Tables.** `users` (email, `password_hash`, `srs_algorithm`), `sessions`
(`token_hash`, `expires_at`), `words` (per-user, `UNIQUE(user_id, word)`,
JSON-stringified definitions/examples, phonetic, audio), `reviews` (SM-2
columns **and** FSRS columns, `UNIQUE(word_id)`), `review_history` (before/
after values, algorithm, JSON snapshot), `user_review_state` (cross-device
positions), `user_review_meta` (cross-device session progress).

All data operations live in `operations.ts` and are user-scoped; `getReview()`
maps snake_case columns to camelCase for the API layer.

## Auth (`lib/auth/`)

- **Passwords** (`password.ts`): Node `scrypt` (N=16384, r=8, p=1, 64-byte key,
  16-byte salt), stored as `scrypt$N$r$p$salt$hash`; verification re-derives
  with the stored parameters (bounded) and compares with `timingSafeEqual`.
- **Sessions** (`session.ts`, `cookies.ts`): 32 random bytes; only the SHA-256
  hash is stored. Cookie `vocleap_session` — httpOnly, `SameSite=Lax`, secure
  in production, 30-day expiry, expired rows deleted on read.
- **Session cache cookie**: `vocleap_session_cache` (JSON user, 5-minute TTL)
  lets `getCurrentUser()` skip the sessions table on repeat navigations.
- **Rate limiting** (`rate-limit.ts`): in-memory 10 attempts / 15 min per
  `ip:email` bucket on login/signup.
- **CSRF** (`csrf.ts`): auth POSTs (login/signup/logout) verify the `Origin`
  header against the request origin (always allowed in development).
- **Redirect safety** (`redirect.ts`): `safeNext()` rejects non-local paths.
- **Legacy claim** (`claim.ts`): if `OWNER_EMAIL` matches the first account,
  pre-multi-user words (`user_id IS NULL`) are claimed at signup/login.

**Enforcement layers:**

1. `proxy.ts` (middleware) — optimistic gate: protected paths redirect to
   `/login?next=…` when the session cookie is absent (cookie presence only, no
   DB check).
2. `app/(app)/layout.tsx` — server component calls `getCurrentUser()` and
   redirects when there is no valid session.
3. API routes — `withUser()` / `requireUser()` (`guard.ts`) resolve the session
   or return 401; ownership is enforced per-record (`assertWordOwned`).

## Scheduling (`lib/srs/`)

Two algorithms, switchable per user via `users.srs_algorithm`
(`GET/PUT /api/settings`); the NavBar hosts the toggle.

- **SM-2** (`sm2.ts`): classic SuperMemo-2. `parseRating`: again→0, hard→3,
  good→4, easy→5. Interval grows 1 → 6 → interval × EF (EF floor 1.3); a lapse
  resets. The next due date is **local midnight in the user's IANA timezone**
  (`lib/timezone.ts`), stored as a UTC instant, keeping the due-queue filter
  (`next_review_date <= datetime('now')`) zone-agnostic.
- **FSRS** (`fsrs.ts`): wraps `ts-fsrs` with short-term steps disabled
  (day-granular like SM-2, 0.9 retention). Card state (stability, difficulty,
  state, lapses, reps) persists in dedicated `reviews` columns; the FSRS due
  date reuses the shared `next_review_date`, so queues and stats stay
  algorithm-agnostic. Switching is non-destructive: the first FSRS review seeds
  memory state from the SM-2 columns, and SM-2's own columns are frozen (not
  overwritten) while FSRS is active — switching back resumes SM-2 exactly.

`POST /api/reviews` reads the user's algorithm per submission; history rows
record which algorithm produced them plus a before/after snapshot.

### Review API (`app/api/reviews`)

| `action=`            | Returns                                              |
| -------------------- | ---------------------------------------------------- |
| `due` / `review`     | Due queue (limit-capped)                             |
| `new`                | Never-reviewed words                                 |
| `all&mode=…`         | Queue with the same filter/order, for saved ordering |
| `stats`              | `{due, total, newWords}` in one query                |
| `history&wordId=X`   | One word's full history                              |
| `history`            | Paginated `{history, total, limit, offset, hasMore}` |
| `intervals&wordId=X` | Per-rating interval preview using the active algo    |

## Cross-device review sync

- `user_review_state` — one row per `(user, device, mode, word)` position;
  `user_review_meta` — one row per `(user, device, mode)` with
  `current_index` / `reviewed_count`.
- `GET /api/review-state?allDevices=true` picks the **latest position per word
  across devices** (window function), filtered to words that can actually
  appear in the current queue — positions only restore ordering, they never add
  words back.
- `POST` replaces the device's slice (upsert + prune of words that left the
  queue) in one chunked multi-row UPSERT.
- Client (`components/ReviewSession.tsx`): merges server state into
  localStorage (last-write-wins per word), writes are debounced (100 ms local,
  500 ms server), a 3-second fallback unblocks the queue if sync is slow, and
  saved state is dropped when its timestamp is from an earlier local calendar
  day (new day = new session).

## Dictionary pipeline (`app/api/translate`)

Public endpoint, no API keys anywhere:

1. **Wiktionary** (`lib/dictionary/wiktionaryApi.ts`) — primary source:
   POS/definition/example parsing plus IPA/enPR phonetics, with retry/backoff.
   Target-language extracts feed CJK translation extraction.
2. **anylang Google fallback** — when Wiktionary misses, an unofficial Google
   Translate web endpoint (via `anylang`) translates the term; failures return
   404 `Word not found`.

Results carry source badges (`wiktionary` / `google-translate`) rendered in
`DictionaryLookup`.

## PWA and offline

- `next.config.ts` wraps the build with `withSerwist` from `@serwist/turbopack`
  (next-pwa is webpack-only and silently produces no service worker under
  Next 16's default Turbopack build). `app/sw.ts` defines the caching
  strategy and is compiled by `app/serwist/[path]/route.ts`; it serves
  precached build assets plus NetworkFirst HTML documents in production
  (`SerwistProvider` registration is disabled in dev).
- `components/SWWarmup.tsx` — after the service worker activates, it
  re-caches the current page's HTML via a `CACHE_URLS` message; without it,
  the first page of a session (loaded before the SW took control) would
  fall back to `/~offline` on an offline reload.
- `lib/pwa/turbopack-worker-shim.ts` (imported by `SWWarmup`) — Turbopack
  passes worker bootstrap config as a `#params=` URL **fragment**, which
  the Cache API strips, so a precached/cached worker chunk served offline
  throws `Missing worker bootstrap config`. The shim wraps
  `window.Worker` and rewrites `#params=` to a `?params=` query (decoded
  once, matching the runtime's own parsing) before construction. Worker
  chunks are excluded from the precache manifest
  (`manifestTransforms` in `app/serwist/[path]/route.ts`) and served by a
  dedicated CacheFirst route in `app/sw.ts` so the query string stays part
  of the cache key.
- `SerwistProvider` in `app/layout.tsx` sets `reloadOnOnline={false}`:
  Chromium fires a spurious `online` event (with `navigator.onLine` still
  `false`) in the outgoing document when an offline navigation swaps
  renderers; the provider's default reload-on-online would then reload
  the previous page and hijack the pending navigation. Reconnection is
  handled by the local-DB sync engine instead.
- `public/manifest.json` — standalone display, PNG icons (192/512 + maskable
  512) and SVG fallbacks; `components/PWAInstallPrompt.tsx` handles
  `beforeinstallprompt` and iOS hints.
- Client persistence uses **localStorage**, not IndexedDB:
  `review_{mode}_positions` (positions map + session meta), a device ID, and
  UI dismissal flags. Offline = cached shell + saved session state; review
  submissions require connectivity.

## API summary

| Route                 | Methods      | Purpose                                    |
| --------------------- | ------------ | ------------------------------------------ |
| `api/auth/login`      | POST         | Origin check → rate limit → session        |
| `api/auth/signup`     | POST         | Validation → create user → session → claim |
| `api/auth/logout`     | POST         | Destroy session + cookies                  |
| `api/auth/me`         | GET          | Current user or 401                        |
| `api/words`           | GET/POST/PUT/DELETE | CRUD + batch import, user-scoped    |
| `api/reviews`         | GET/POST     | Queues, stats, history, intervals, submit  |
| `api/review-state`    | GET/POST/DELETE | Cross-device position sync              |
| `api/settings`        | GET/PUT      | `srs_algorithm` (`sm2` \| `fsrs`)          |
| `api/translate`       | POST         | Dictionary lookup (public)                 |
