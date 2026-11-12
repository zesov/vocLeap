## Project context (vocleap)

Offline-first vocabulary PWA. Stack: Next.js 16.4.3 (Turbopack), React 19, Tailwind CSS 4, TypeScript. Server DB: better-sqlite3 (local dev) or Turso `@libsql/client` (`DB_MODE=turso`). Client offline DB: SQLite (wa-sqlite / `@sqlite.org/sqlite-wasm`) inside a Web Worker. PWA via Serwist. SRS: SM-2 and FSRS (`ts-fsrs`).

Commands: dev `bun run dev` (predev copies WASM into `public/`), lint `bun run lint`, typecheck `bunx tsc --noEmit`, server schema migration `bun run migrate` (explicit, never in the request path; only local mode auto-ensures schema on import), Browser QA `bunx playwright`.

Key directories:
- `app/` — App Router. Route groups: `(app)` (`/review`, `/words`, `/review-history`), `(public)` (landing, `/dictionary`, `/login`, `/signup`), `~offline` SW fallback page. API routes under `app/api/`: `sync/push`, `sync/pull`, `auth/*`, `words`, `reviews`, `review-state`, `settings`, `translate`
- `components/` — shared UI (ReviewSession, NavBar, SyncStatus, LocalDbInit, SWWarmup, PWAInstallPrompt, ui primitives)
- `lib/local-db/` — client-side offline SQLite: `sqlite-worker.ts` + `worker/engine-*.ts` (wa-sqlite / sqlite-wasm), `schema.ts`, `operations.ts`, `submit-review.ts` (local-first review submission), `dict-cache.ts` (offline dictionary cache)
- `lib/local-db/sync/` — client sync: `engine.ts` (push/pull cycle, scheduler, status phases), `oplog.ts` (`sync_ops` queue), `merge.ts` (pull merge with pending-op guards), `trigger.ts` (`requestSync`, page-exit keepalive flush)
- `lib/sync/` — server side of the protocol: `server-apply.ts` (idempotent op apply, last-write-wins), `server-pull.ts` (cursor pages), `cursor.ts`, `types.ts`
- `lib/data/` — data facade: `getData()` / `useData()` return a local implementation once the worker DB is ready, otherwise HTTP; identical response shapes, so components never branch on mode
- `lib/db/` — server-side SQLite adapter (local `better-sqlite3` at `./data/vocleap.db`, gitignored; or Turso via `DB_MODE=turso` + `TURSO_URL`/`TURSO_AUTH_TOKEN`) and `operations.ts`
- `lib/srs/` — `sm2.ts`, `fsrs.ts`, `schedule.ts` (one `scheduleReview` shared by client submission and the server API)
- `lib/auth/` — session-cookie auth: `guard.ts` (`withUser`), `cookies.ts`, `password.ts`, `csrf.ts`, `rate-limit.ts`
- `proxy.ts` — Next 16 proxy (middleware): unauthenticated users are redirected off `/review`, `/review-history`, `/words` to `/login`
- `scripts/` — `migrate.ts` (schema), `migrate-multiuser.ts`, `backfill-phonetic.ts`, `backfill-uuid.ts`

Offline-first sync model (do not break these invariants):
- Writes are local-first, never on the network critical path: `submitReviewLocal()` writes the review row, history row, and two `sync_ops` entries in ONE atomic batch; scheduling is computed client-side via `lib/srs/schedule.ts`.
- Push: `POST /api/sync/push` applies ops idempotently with LWW (words by `updated_at`, reviews by `last_reviewed`, history insert-or-ignore by uuid). Acked opIds are deleted from the local oplog. A rejected op PAUSES sync (phase `paused`); `components/SyncStatus.tsx` shows the reason plus a Retry button (`resetSyncPause()` + `requestSync()`) and a Discard button that removes the poison op from the oplog after a confirm (`discardRejectedOp()` in `lib/local-db/sync/engine.ts`, rejected opId carried in `SyncStatus.rejectedOpId`).
- Pull: `GET /api/sync/pull?cursor=…` incremental pages; merge skips any word/review that still has a pending local op; the cursor lives in the local meta table.
- Triggers: after every local write (`requestSync` = immediate push + 250 ms debounced full cycle), a 60 s scheduler, `online`/visibility events, and a keepalive page-exit flush.
- ReviewSession queue-position state: localStorage plus per-word LWW merge with `/api/review-state`.

Important files:
- `components/ReviewSession.tsx` — keyboard shortcuts: Space toggles Show Answer, 1–4 rate Again/Hard/Good/Easy
- `app/(app)/review-history/page.tsx` — history table with infinite scroll (`GET /api/reviews?action=history&limit=30&offset=N` → `{ history, total, limit, offset, hasMore }`; `&wordId=X` still returns one word's full history)
- `app/(app)/words/page.tsx` — word list + Import Words (hidden file input, `.txt/.json/.csv`) + Sort by control (`date_desc|date_asc|alpha_asc|alpha_desc`) + phonetic line per card
- `app/api/reviews/route.ts` — GET (`action=due|review|new|stats|history[&wordId=X]`) and POST (review submission)
- `components/NavBar.tsx` — nav items: Dictionary, Review, History, My Words; logo links to `/`
- `lib/srs/sm2.ts` — `parseRating("again"|"hard"|"good"|"easy")` → 0/3/4/5

Notes:
- Branching: `main` = production — releases and tags happen only there (`bun run release --patch` on main). `dev` = preview branch (Vercel). Feature branches merge into `dev` only (never straight into `main`, never both); shipping is `dev` → `main` with `--no-ff`, then backmerge `main` → `dev` after every release.
- The client worker DB needs a SharedArrayBuffer-capable context; `SWWarmup.tsx` + `LocalDbInit.tsx` boot it, and only one tab may own the worker (SyncStatus banners "open in another tab" otherwise).
- E2E tests live in `tests/e2e/` (Playwright, baseURL `http://localhost:3001` in `playwright.config.ts`; PWA variant `playwright.pwa.config.ts`); unit tests in `tests/unit/` (e.g. `tests/unit/local-db/sync/engine.test.ts`).


<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
