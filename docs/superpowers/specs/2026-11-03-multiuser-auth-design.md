# Design: Multi-user foundation (stage 1)

Date: 2026-11-03
Status: Approved for implementation planning

## Problem

Vocleap has no concept of a user. The database has `words`, `reviews`, and
`review_history` but no `user_id` or `device_id`, and every visitor shares the
same data. Review progress is stored server-side in `reviews`, but the current
card position lives in `localStorage` (`components/ReviewSession.tsx`), so it
does not follow a user to another device.

The product will become multi-user. That requires identity before cross-device
session state can be attached to anything. This spec covers stage 1: accounts
and per-user data isolation. Stage 2 (cross-device review cursor) builds on it
and gets its own spec.

## Goals

- Email + password accounts with server-side sessions.
- Every user has their own words; reviews and review history are isolated
  through the words they belong to.
- Existing data (the owner's ~2008 words and review history) is claimed by the
  owner's account exactly once.
- Authentication is required for word/review pages and APIs.
- No new runtime dependencies.

## Non-goals (stage 1)

- Email verification, password reset, OAuth, account deletion, profile editing.
- Cross-device review cursor sync (stage 2).
- Admin UI, teams, sharing, or billing.
- Strong distributed rate limiting. The login throttle is best-effort only.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Identity model | Own `users` + `sessions` tables | Full control, no dependency, works with the existing dual SQLite/Turso adapter |
| Password hashing | Node `crypto.scrypt` | Built in, memory-hard, no native addon |
| Session transport | Opaque random token in HttpOnly cookie; SHA-256 hash in DB | DB leak does not expose usable session tokens |
| Word ownership | `words.user_id` | A user's vocabulary is private |
| Review ownership | Derived via `words.id` join | Per-user words make `word_id` globally unique, so `reviews`/`review_history` need no `user_id` |
| Existing data claim | `OWNER_EMAIL` env + first account only | No email verification, so email alone would let an attacker claim the library |
| Route protection | Server layout guard + `requireUser()` in handlers | Proxy/middleware cannot safely query the DB and cookie presence is not validity |
| Free-text uniqueness | `UNIQUE(user_id, word)` | Two users must both be able to save "apple" |

## Data model

### New tables

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
```

### `words`

Final shape:

```sql
CREATE TABLE words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  translation TEXT NOT NULL,
  definitions TEXT,
  examples TEXT,
  phonetic TEXT,
  audio_url TEXT,
  source_language TEXT DEFAULT 'en',
  target_language TEXT DEFAULT 'zh-CN',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, word)
);
```

`user_id` stays nullable at the database level because legacy rows are
unclaimed until the owner registers. Application code always writes a non-null
`user_id`; queries always filter by it.

`reviews` and `review_history` are unchanged. Their `word_id` foreign keys keep
`ON DELETE CASCADE`, and all access goes through a `words` join scoped by
`user_id`.

Indexes: `idx_words_word` (existing), new `idx_words_user` on `words(user_id)`.

### Migration of an existing database

SQLite cannot alter a table constraint, so `words` must be rebuilt to replace
`UNIQUE(word)` with `UNIQUE(user_id, word)`. Turso enforces foreign keys and
does not reliably allow disabling them, so the rebuild must never drop a table
that has live dependents.

Rebuild order (single write transaction/batch):

```text
1. CREATE TABLE words_new (... final shape ...)
2. INSERT INTO words_new (id, word, ...) SELECT id, word, ... FROM words
3. CREATE TABLE reviews_new (... REFERENCES words_new(id) ON DELETE CASCADE ...)
4. INSERT INTO reviews_new SELECT ... FROM reviews
5. CREATE TABLE review_history_new (... REFERENCES words_new(id) ON DELETE CASCADE ...)
6. INSERT INTO review_history_new SELECT ... FROM review_history
7. DROP TABLE review_history          -- children first: safe with FKs on
8. DROP TABLE reviews
9. DROP TABLE words                    -- no remaining dependents
10. ALTER TABLE words_new RENAME TO words
11. ALTER TABLE reviews_new RENAME TO reviews
12. ALTER TABLE review_history_new RENAME TO review_history
13. CREATE INDEX idx_words_word, idx_words_user,
    idx_reviews_next_review, idx_review_history_word
```

Renaming `words_new` updates the FK references in `reviews_new` and
`review_history_new` (SQLite >= 3.26, which both backends satisfy). Row ids are
preserved, so review data stays attached to the same words. Explicit-id inserts
also keep `sqlite_sequence` correct for `AUTOINCREMENT`.

Implementation:

- `scripts/migrate-multiuser.ts`, run with `bun run migrate:multiuser`.
- Idempotent: if `words` already has a `user_id` column, do nothing. If the DB
  is empty, create the final schema.
- Creates `users` and `sessions` first, so the rebuilt `words.user_id` foreign
  key always has a target even when the script runs before the new app boots.
- Uses the configured backend (`DB_MODE`), local or Turso.
- Adds `batch(statements: string[])` to `DatabaseAdapter` so the rebuild is one
  atomic write on both backends (`better-sqlite3` transaction; `@libsql/client`
  `batch(..., "write")`).
- Prints a summary (rows copied, resulting columns).
- `initDatabase()` only runs `CREATE TABLE IF NOT EXISTS` for the new tables and
  the final `words` shape. It does not perform the rebuild automatically.
- Before running against Turso, verify on a Turso branch or with a dump; see
  Rollout.

## Authentication

### Password hashing (`lib/auth/password.ts`)

- `hashPassword(password): Promise<string>`
  - 16-byte random salt
  - scrypt N=16384, r=8, p=1, key length 64, async (`crypto.scrypt`)
  - encoded as `scrypt$16384$8$1$<salt base64url>$<hash base64url>`
- `verifyPassword(password, stored): Promise<boolean>`
  - parses the encoded parameters so they can be raised later
  - constant-time compare with `crypto.timingSafeEqual`
  - malformed stored value returns `false`

Validation: email is trimmed and lowercased; password minimum 8 characters,
maximum 200.

### Sessions (`lib/auth/session.ts`)

- `createSession(userId)`: 32 random bytes, base64url token; insert
  `sha256(token)` with `expires_at = now + 30 days`; set cookie.
- `getCurrentUser()`: read cookie, hash, look up an unexpired session joined to
  `users`, delete the row if expired, return `{ id, email } | null`.
- `destroySession()`: delete the row and clear the cookie.
- Cookie: name `vocleap_session`, `httpOnly: true`, `sameSite: "lax"`,
  `path: "/"`, `secure: process.env.NODE_ENV === "production"`, `maxAge` 30 days.
- Fixed 30-day expiry. No sliding renewal in stage 1.

The cookie is set/cleared only in Route Handlers (Next `cookies()` is async and
cannot be written during Server Component render).

### Route guard (`lib/auth/guard.ts`)

- `requireUser(): Promise<User>` returns the current user or throws a typed
  `UnauthorizedError`.
- API handlers wrap their body in one `try/catch`; catching
  `UnauthorizedError` returns JSON 401, every other error returns 500.
- Pages use `getCurrentUser()` and `redirect("/login")` from a server layout.

### CSRF (`lib/auth/csrf.ts`)

For mutation handlers, if an `Origin` header is present it must match the
request's own origin; otherwise respond 403. `SameSite=Lax` is the first line of
defense, this is the second.

### Login throttle (`lib/auth/rate-limit.ts`)

Best-effort in-memory fixed window: 10 attempts per 15 minutes per
`ip + normalized email`, returning 429 when exceeded. Reset time is returned in
the JSON body. Documented limitation: on serverless, each instance has its own
map, so this raises the bar but is not a guarantee.

### Endpoints

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/signup` | `{ email, password }` | 201 `{ user }` + cookie | 400 invalid, 409 email exists, 429 throttled |
| POST | `/api/auth/login` | `{ email, password }` | 200 `{ user }` + cookie | 401 invalid credentials, 429 throttled |
| POST | `/api/auth/logout` | none | 204, cookie cleared | 403 bad origin |
| GET | `/api/auth/me` | none | 200 `{ user }` | 401 |

Login errors are always "Invalid email or password". Signup returns 409 for an
existing email (acceptable enumeration trade-off for this product size).

### Owner data claim

`claimLegacyWords(user)` runs after successful signup and login:

```text
if normalize(user.email) !== normalize(process.env.OWNER_EMAIL): return
if OWNER_EMAIL is empty: return
if (SELECT COUNT(*) FROM users) !== 1: return
UPDATE words SET user_id = ? WHERE user_id IS NULL
```

The `users === 1` condition makes the claim work only for the very first
account. This is a deliberate safety measure: without email verification, an
attacker who knows the owner's email could otherwise register it first and take
over the entire library. If someone else registers first, the owner must use the
manual recovery path documented in the README (`bun run claim-owner --email=...`,
a small script added in this stage).

Running the claim on login as well as signup makes it recoverable if the
signup-time update fails.

## Authorization and data scoping

### Data operations (`lib/db/operations.ts`)

Every user-data function takes `userId` as its first parameter:

- `createWord(userId, word)`
- `getWordById(userId, id)`
- `getWordByText(userId, word)`
- `getAllWords(userId, limit, offset)`
- `updateWord(userId, id, updates)`
- `deleteWord(userId, id)`
- `getReview(userId, wordId)`
- `getDueReviews(userId, limit)`
- `getNewWords(userId, limit)`
- `getReviewStats(userId)`
- `getReviewHistory(userId, wordId)`
- `getAllReviewHistory(userId)`

`createOrUpdateReview` and `addReviewHistory` keep their signatures but may only
be called after `assertWordOwned(userId, wordId)` succeeds.

Rules:

- `words` queries use `WHERE user_id = ?`.
- Review queries use `JOIN words w ON r.word_id = w.id WHERE w.user_id = ?`.
- `assertWordOwned` returns 404 (not 403) for another user's word id, so ids are
  not enumerable.
- `getWordByText` is scoped, so duplicate detection and import behave per user.

### API protection matrix

| Route | Auth |
| --- | --- |
| `/api/auth/*` | public |
| `/api/translate` | public (no user data) |
| `/api/words` (GET/POST/PUT/DELETE) | required |
| `/api/reviews` (GET/POST) | required |
| `/api/review-state` (stage 2) | required |

## UI

### New pages

- `/login` and `/signup`: client forms posting JSON to the auth endpoints.
  Success: `router.push(next ?? "/review")` and `router.refresh()`.
  Both render inside the normal shell and link to each other.
  `/login` reads an optional `next` search param, restricted to same-origin
  relative paths.
- Home (`/`): add Sign in / Create account actions. Replace the stale
  "Data stored locally with SQLite" copy with a sync-across-devices message.

### Protected pages

Create `app/(app)/layout.tsx` as an async server component:

```tsx
const user = await getCurrentUser();
if (!user) redirect("/login");
return <>{children}</>;
```

Move `app/review`, `app/words`, and `app/review-history` to
`app/(app)/review`, `app/(app)/words`, `app/(app)/review-history` with
`git mv`. URLs do not change. `/dictionary` stays public.

`/dictionary` save behavior: if `/api/words` returns 401, the UI shows
"Sign in to save this word" with a link to `/login`.

### NavBar

- Fetch `/api/auth/me` on mount (no server prop plumbing).
- Signed in: show the email (truncated) and a "Sign out" action that posts to
  `/api/auth/logout`, then pushes `/login` and refreshes.
- Signed out: show "Sign in".
- Mobile menu includes the same actions with 44px targets.
- Avoid a hydration mismatch: render auth actions only after the first fetch
  resolves.

## Error handling

- Expired or deleted session: pages redirect to `/login`; APIs return 401.
- Duplicate email: 409. Invalid email or short password: 400 with a field-level
  message.
- Unknown user id / word id belonging to someone else: 404.
- Wrong email or password: 401 with a generic message.
- Throttled: 429 with `retryAfterSeconds`.
- Migration failure: transaction rolls back; script exits non-zero and prints
  the failing statement.

## Testing

Commands:

- `bunx tsc --noEmit`
- `bun run lint`
- `bunx playwright test`

Playwright fixes:

- `playwright.config.ts`: start the dev server on the same port as `baseURL`
  (`3001`) and pass `DB_PATH=./data/test.db` and
  `OWNER_EMAIL=owner@test.local` via `webServer.env`.
- Add `globalSetup` that removes `./data/test.db` before the run.
- Rewrite `tests/e2e/dictionary.spec.ts`; it still assumes the home page has the
  lookup form, but home is now a landing page.

New `tests/e2e/auth.spec.ts` (serial, unique email per run):

1. Signup succeeds, lands on `/review`, nav shows the email.
2. Logout returns to `/login`; visiting `/words` redirects to `/login`.
3. Login with the same credentials restores access.
4. Wrong password returns a generic error and stays on `/login`.
5. Two browser contexts, same user: a word saved in A is visible in B.
6. User B cannot see user A's words; `GET /api/words?id=<A's id>` returns 404
   and the page shows an empty list.
7. Owner claim: seed one `words` row with `user_id IS NULL` directly via
   `better-sqlite3`, sign up as `owner@test.local`, confirm the word is visible;
   a second account does not receive any unclaimed words.

## Rollout

1. Back up the target database. Local: copy `data/vocleap.db` after a WAL
   checkpoint. Turso: branch or dump before migrating.
2. Run `bun run migrate:multiuser` against the target (`DB_MODE`, `DB_PATH` /
   `TURSO_*`).
3. Set `OWNER_EMAIL` in the deployment environment.
4. Deploy.
5. Register the owner account first, with that email. Confirm the expected word
   count on `/words`.
6. Run the Playwright suite against the deployed build.

Rollback: restore the database backup and redeploy the previous version. The
migrated schema is backwards compatible with the old code except that old code
ignores `user_id` (it would show all users' words), so rollback is only safe
together with the DB restore.

## Risks

- **Owner claim race**: a stranger registering first disables the automatic
  claim. Mitigated by the first-account rule plus the manual claim script and
  the rollout order above.
- **Table rebuild on Turso**: verified by the migration script's idempotency and
  by testing on a Turso branch before production.
- **In-memory throttle**: per-instance only. Acceptable for stage 1; revisit if
  abusive traffic appears.
- **Session fixation / theft**: tokens are random, hashed at rest, HttpOnly, and
  Secure in production. No rotation on privilege change (no privilege changes
  exist yet).
