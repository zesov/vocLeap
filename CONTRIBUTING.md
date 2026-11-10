# Contributing to Vocleap

Thanks for your interest in improving Vocleap! Bug reports, feature ideas, and
pull requests are all welcome.

## Development setup

```bash
git clone https://github.com/zesov/vocLeap.git
cd vocLeap
bun install
cp .env.example .env   # local SQLite works with zero configuration
bun run dev
```

Open http://localhost:3000 and sign up — the local database is created
automatically on first start.

## Before you open a PR

Run all three checks locally:

```bash
bun run lint           # ESLint
bunx tsc --noEmit      # typecheck
bunx playwright test   # E2E (boots an isolated dev server on :3101 with its own SQLite)
```

For user-facing changes, add or adjust an E2E spec in `tests/e2e/` — the
existing eight specs cover auth, dictionary, review, history, and word-list
behaviour and are a good template.

## Conventions

- **Commits**: Conventional Commits style, matching the existing history
  (`feat:`, `fix:`, `perf(api):`, `docs:`, …).
- **Data access**: all DB operations go through `lib/db/operations.ts` and must
  be user-scoped. Never query tables directly from routes.
- **Auth**: API routes resolve the session via `withUser()` / `requireUser()`
  (`lib/auth/guard.ts`); per-record ownership uses `assertWordOwned`.
- **Schema changes**: extend the DDL and the inspect query in `lib/db/schema.ts`
  (`ensureSchema()` must stay idempotent — one inspect, one atomic batch). Do
  **not** add schema work to the request path for Turso mode; local mode
  converges automatically, production migrates via `bun run migrate`.
- **Changelog**: add a dated entry to `CHANGELOG.md` for user-facing changes.

## Reporting bugs

Open a GitHub issue with steps to reproduce, expected vs actual behaviour, and
your deployment mode (local SQLite or Turso). For security issues, please
follow the [security policy](SECURITY.md) instead of opening a public issue.
