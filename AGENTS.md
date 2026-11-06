<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Important
- Browser QA uses the bash command `bunx playwright`.

## Project context (vocleap)

Stack: Next.js 16.4.3 (Turbopack), React 19, Tailwind CSS 4, better-sqlite3, @libsql/client, TypeScript. Dev command: `bun run dev`. Lint: `bun run lint`. Typecheck: `bunx tsc --noEmit`. Browser QA: `bunx playwright`.

Key directories:
- `app/` — App Router pages and API routes (`/dictionary`, `/review`, `/review-history`, `/words`, `/api/translate`, `/api/words`, `/api/reviews`)
- `components/` — shared UI (NavBar, ReviewSession, ui primitives)
- `lib/db/` — Dual-backend SQLite: local (`better-sqlite3`) or Turso (`@libsql/client`). Schema/init (`init.ts`) and data operations (`operations.ts`)
- `lib/srs/` — SM-2 algorithm (`sm2.ts`)
- `data/vocleap.db` — Local SQLite database (gitignored, used when DB_MODE=local)

Important files:
- `app/api/reviews/route.ts` — GET (`action=due|review|new|stats|history[&wordId=X]`) and POST (SM-2 review submission)
- `app/review/page.tsx` — ReviewSession with keyboard shortcuts: Space toggles Show Answer, 1–4 rate Again/Hard/Good/Easy
- `app/(app)/review-history/page.tsx` — review history table with infinite scroll (GET `/api/reviews?action=history&limit=30&offset=N`)
- `app/(app)/words/page.tsx` — word list + Import Words button (triggers hidden file input, `.txt/.json/.csv`) + Sort by control (`date_desc|date_asc|alpha_asc|alpha_desc`) + phonetic line on each card
- `components/NavBar.tsx` — nav items: Dictionary, Review, History, My Words; logo links to `/`
- `lib/db/operations.ts` — `getReview()` maps snake_case DB columns to camelCase (fixes `NOT NULL constraint failed: reviews.ease_factor` on submission)
- `lib/db/init.ts` — Dual-backend DB adapter. `DB_MODE=local` (default) uses `better-sqlite3` at `./data/vocleap.db`; `DB_MODE=turso` uses `@libsql/client` connecting to `TURSO_URL` (defaults to `libsql://your-database-your-org.turso.io`, auth via `TURSO_AUTH_TOKEN`). All DB operations are async through a unified `DatabaseAdapter` interface.
- `lib/srs/sm2.ts` — `parseRating("again"|"hard"|"good"|"easy")` → 0/3/4/5

Notes:
- SQLite DB path defaults to `./data/vocleap.db` (gitignored). `lib/db/init.ts` runs on import and creates tables.
- Review history API: `GET /api/reviews?action=history&limit=30&offset=N` returns a page in `{ history, total, limit, offset, hasMore }`; `&wordId=X` still returns one word's full history.
- The `vocLeap/` vs `vocleap/` path case: git root is the parent folder; the project lives in `vocLeap/`. File paths inside the project use `vocleap/` (lowercase) consistently.
- E2E tests live in `tests/e2e/` (Playwright), baseURL `http://localhost:3001` in `playwright.config.ts`.

