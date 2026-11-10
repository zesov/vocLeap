# Vocleap

An open-source vocabulary learning PWA: look words up in a built-in dictionary,
save them to your private list, and memorize them with spaced repetition — on
any device.

🚀 **[Try the live demo](https://vocleap.vercel.app)**

<p align="center">
  <img src="docs/screenshots/review.png" width="49%" alt="Review session with spaced repetition scheduling">
&nbsp;
  <img src="docs/screenshots/dictionary.png" width="49%" alt="Dictionary lookup with Wiktionary definitions and phonetics">
</p>
<p align="center">
  <img src="docs/screenshots/words.png" width="80%" alt="Word list with phonetics, translations, and definitions">
</p>

## Features

- **Dictionary lookup** — definitions, examples, and phonetics from Wiktionary
  with translation fallback; public, no account needed
- **Spaced repetition** — SM-2 by default, switchable to FSRS per user; rating
  buttons preview the scheduled interval before you commit
- **Cross-device sessions** — review positions sync across your devices and the
  queue resumes where you left off
- **Multi-user accounts** — email + password sign-up; every word list is private
- **Review history** — per-word history with before/after memory-state snapshots
- **Word list** — batch import from `.txt` / `.json` / `.csv`, sortable cards
  with phonetics
- **Installable PWA** — service-worker cached, installs to your home screen
- **Timezone-aware scheduling** — words come due at local midnight, wherever
  you are

## Tech stack

Next.js 16 (App Router, Turbopack) · React 19 · Tailwind CSS 4 · TypeScript ·
SQLite (better-sqlite3) or Turso (libSQL) · ts-fsrs · next-pwa · Playwright

## Quick start

Prerequisites: [Bun](https://bun.sh) 1.2+ (Node 20+ also works).

```bash
git clone https://github.com/zesov/vocLeap.git
cd vocLeap
bun install
cp .env.example .env   # DB_MODE=local works out of the box
bun run dev
```

Open http://localhost:3000, sign up, and start saving words. Local SQLite needs
no configuration.

For production — Turso, migrations, Vercel region colocation, upgrading an
existing database — see **[docs/self-hosting.md](docs/self-hosting.md)**.

## Scripts

| Command                        | What it does                                                    |
| ------------------------------ | --------------------------------------------------------------- |
| `bun run dev`                  | Dev server (Turbopack)                                          |
| `bun run build` / `start`      | Production build / serve                                        |
| `bun run lint`                 | ESLint                                                          |
| `bunx tsc --noEmit`            | Typecheck                                                       |
| `bunx playwright test`         | E2E tests (isolated dev server + SQLite on `:3101`)             |
| `bun run migrate`              | Apply schema migrations (explicit, idempotent)                  |
| `bun run migrate:multiuser`    | One-shot `words` table rebuild for multi-user support           |
| `bun run claim-owner`          | Assign pre-multi-user words to an account                       |
| `bun run backfill:phonetic`    | Backfill phonetics for saved words                              |
| `bun run reset:unreviewed`     | Delete placeholder review rows left by older versions           |

## Project layout

```
app/                 # App Router: (public) home/dictionary/login/signup, (app) review/words/history
app/api/             # REST routes: words, reviews, review-state, settings, auth, translate
components/          # NavBar, ReviewSession, DictionaryLookup, PWA install prompt, UI primitives
lib/db/              # Dual-backend SQLite adapter: better-sqlite3 (local) | @libsql/client (Turso)
lib/auth/            # scrypt passwords, hashed session tokens, rate limiting, origin checks
lib/srs/             # Scheduling: sm2.ts and fsrs.ts (ts-fsrs), switchable per user
lib/dictionary/      # Wiktionary API client
docs/                # Self-hosting guide, architecture notes
tests/e2e/           # Playwright end-to-end specs
```

## Documentation

- [Self-hosting](docs/self-hosting.md) — environment variables, Turso, migrations, Vercel deployment
- [Architecture](docs/architecture.md) — how the DB adapter, auth, SRS, and sync layers fit together
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
