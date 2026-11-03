This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Accounts and multi-user data

Vocleap uses email + password accounts. Each user has a private vocabulary;
words, reviews, and review history are isolated by `words.user_id`.

- Sign up at `/signup`, sign in at `/login`.
- `GET/POST/PUT/DELETE /api/words` and `/api/reviews` require a session.
- `/review`, `/words`, and `/review-history` redirect to `/login` when signed out.
- `/dictionary` is public; saving a word requires an account.

### Environment

Copy `.env.example` to `.env.local` and set:

- `DB_MODE` (`local` or `turso`)
- `OWNER_EMAIL` — the email that should own all pre-multi-user words

### Upgrading an existing database

The `words` table must be rebuilt to allow the same word for different users.
Run once per database, before deploying the new code:

```bash
# local
DB_PATH=./data/vocleap.db bun run migrate:multiuser

# turso
DB_MODE=turso TURSO_URL=... TURSO_AUTH_TOKEN=... bun run migrate:multiuser
```

The script is idempotent. Back up the database first. For Turso, test on a
branch before production.

### First signup claims existing words

If `OWNER_EMAIL` is set and the account being created is the **first** account,
all words with `user_id IS NULL` are assigned to it. Sign up with that email
immediately after deploying.

If someone else registers first, the automatic claim is disabled. Recover with:

```bash
bun run claim-owner --email=you@example.com
```

### Reset a forgotten password (manual)

There is no password reset flow yet. Generate a new hash and update the row:

```bash
bun -e 'const { hashPassword } = await import("./lib/auth/password.ts"); console.log(await hashPassword("new-password"))'
sqlite3 data/vocleap.db "UPDATE users SET password_hash = '<paste hash>' WHERE email = '<your email>';"
```

For Turso, run the equivalent `UPDATE` in the Turso shell.
