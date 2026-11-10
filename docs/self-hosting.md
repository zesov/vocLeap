# Self-hosting Vocleap

Vocleap runs anywhere Next.js runs. The default configuration uses a local
SQLite file and needs zero external services; production deployments typically
use [Turso](https://turso.tech) (hosted libSQL) on Vercel.

## Requirements

- [Bun](https://bun.sh) 1.2+ (Node 20+ also works)
- A SQLite file (local mode) or a Turso database (cloud mode)

## Environment variables

Copy `.env.example` to `.env` and adjust:

| Variable          | Default              | Description                                        |
| ----------------- | -------------------- | -------------------------------------------------- |
| `DB_MODE`         | `local`              | `local` (better-sqlite3) or `turso` (@libsql/client) |
| `DB_PATH`         | `./data/vocleap.db`  | SQLite file path, used when `DB_MODE=local`        |
| `TURSO_URL`       | —                    | libSQL URL, used when `DB_MODE=turso`              |
| `TURSO_AUTH_TOKEN`| —                    | Turso authentication token                         |
| `OWNER_EMAIL`     | —                    | Email that claims pre-multi-user words (see below) |

Maintenance scripts load `.env` automatically
(`node --env-file-if-exists=.env`). Next.js also reads `.env.local`, so you can
split app-only variables there if you prefer.

## Accounts and multi-user data

Vocleap uses email + password accounts. Each user has a private vocabulary;
words, reviews, and review history are isolated by `words.user_id`.

- Sign up at `/signup`, sign in at `/login`.
- `GET/POST/PUT/DELETE /api/words` and `/api/reviews` require a session.
- `/review`, `/words`, and `/review-history` redirect to `/login` when signed out.
- `/dictionary` is public; saving a word requires an account.

## Schema migrations

Schema changes are an **explicit** operation, not something the app does on
every request/cold start:

- **Local development**: the schema is converged automatically once per
  server start (in-process SQLite, effectively free). No manual step needed.
- **Turso / production**: never auto-migrated — a serverless cold start pays
  zero DB round trips for schema checks. Run the migration explicitly after
  pulling schema changes and before deploying a release that needs them:

  ```bash
  DB_MODE=turso TURSO_URL=... TURSO_AUTH_TOKEN=... bun run migrate
  ```

The script is idempotent: one inspect query, and only the missing DDL as a
single atomic batch (`Schema already up to date. Nothing to do.` when current).
Run it against a branch database first when possible.

### Upgrading an existing pre-multi-user database

The `words` table must be rebuilt to allow the same word for different users.
Run once per database, before deploying the multi-user code:

```bash
# local
DB_PATH=./data/vocleap.db bun run migrate:multiuser

# turso
DB_MODE=turso TURSO_URL=... TURSO_AUTH_TOKEN=... bun run migrate:multiuser
```

The script is idempotent. Back up the database first. For Turso, test on a
branch before production.

## First signup claims existing words

If `OWNER_EMAIL` is set and the account being created is the **first** account,
all words with `user_id IS NULL` are assigned to it. Sign up with that email
immediately after deploying.

If someone else registers first, the automatic claim is disabled. Recover with:

```bash
bun run claim-owner --email=you@example.com
```

## Reset a forgotten password (manual)

There is no password reset flow yet. Generate a new hash and update the row:

```bash
bun -e 'const { hashPassword } = await import("./lib/auth/password.ts"); console.log(await hashPassword("new-password"))'
sqlite3 data/vocleap.db "UPDATE users SET password_hash = '<paste hash>' WHERE email = '<your email>';"
```

For Turso, run the equivalent `UPDATE` in the Turso shell.

## Deploying to Vercel

1. Create a Turso database close to your users and note its URL and token.
2. Set the environment variables (`DB_MODE=turso`, `TURSO_URL`,
   `TURSO_AUTH_TOKEN`, `OWNER_EMAIL`) in the Vercel project.
3. Run `bun run migrate` against the production database before the first
   deploy that needs the new schema.
4. Deploy. `vercel.json` pins the serverless functions to `sin1` (Singapore)
   so they sit next to the Turso instance — every SQL statement crosses the
   network, so colocating functions and database is the single biggest latency
   win. Change the region in `vercel.json` to match your Turso location.

## Maintenance scripts

| Command                      | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `bun run migrate`            | Apply pending schema migrations (idempotent)                   |
| `bun run migrate:multiuser`  | One-shot `words` table rebuild for multi-user support          |
| `bun run claim-owner`        | Assign pre-multi-user words to an account                      |
| `bun run backfill:phonetic`  | Backfill phonetics for already-saved words                     |
| `bun run reset:unreviewed`   | Delete placeholder review rows left by older versions          |
