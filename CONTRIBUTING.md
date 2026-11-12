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

## Branching model

- **`main`** — production. The only branch that gets tagged and released
  (`bun run release --patch` runs here).
- **`dev`** — preview. Features land here first; the Vercel preview deployment
  tracks it, so unreleased work is testable before shipping.
- **Feature branches** (`feat/…`, `fix/…`) are short-lived and merge into
  **`dev` only** — never straight into `main`, and never into both.

```bash
git checkout dev && git pull
git checkout -b feat/xxx          # one branch = one topic
# …work, conventional commits…
git merge dev                     # keep the branch current if dev moved
git checkout dev
git merge --no-ff feat/xxx        # keeps the feature grouped in history
git push origin dev               # preview deployment updates
git branch -d feat/xxx
```

When the preview is ready to ship:

```bash
git checkout main
git merge --no-ff dev             # the only way main receives feature work
git push origin main
bun run release --patch           # tag + GitHub Release, always from main
git checkout dev
git merge main                    # backmerge the release commit (CHANGELOG +
git push origin dev               # package.json bump) so dev never lags
```

Three rules keep the branches from diverging:

1. A feature branch merges into exactly **one** destination (`dev`).
2. Tags and GitHub Releases happen **only on `main`**.
3. After every release, backmerge `main` → `dev` — the release commit bumps
   `CHANGELOG.md` and `package.json` on `main`.

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
