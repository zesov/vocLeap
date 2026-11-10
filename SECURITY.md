# Security Policy

## Reporting a vulnerability

Please report security issues privately — do **not** open a public issue.

- Preferred: GitHub **Security Advisories → "Report a vulnerability"** on this
  repository, or
- Email: baich.info@gmail.com

Include a description, reproduction steps, impact, and the affected
pages/endpoints. You'll get an acknowledgement within 7 days, and a fix target
of 30 days for critical/high-severity issues.

## Scope

In scope:

- The auth flows: login, signup, session handling, password storage
- Authorization/isolation between accounts (`words.user_id` scoping, API guards)
- SQL injection, XSS, CSRF, open redirects, rate-limit bypass
- The dictionary/translate endpoint's handling of untrusted input

Out of scope:

- Misconfiguration of self-hosted deployments (exposed `.env`, public Turso
  instances, etc.)
- Vulnerabilities in upstream services (Wiktionary, Google Translate endpoints)
- Reports from automated scanners without a working proof of concept

## Design notes

Security-relevant implementation details, for reviewers:

- Passwords: Node `scrypt` with per-user salt; verification uses
  `timingSafeEqual` with bounded stored parameters (`lib/auth/password.ts`).
- Sessions: 32 random bytes, stored only as SHA-256 hashes; httpOnly,
  `SameSite=Lax`, `secure` in production cookies (`lib/auth/session.ts`).
- Login/signup/logout verify the `Origin` header (CSRF); login/signup are rate
  limited in memory (10 / 15 min per IP+email) (`lib/auth/`).
- All word/review data is user-scoped at the query level; ownership is asserted
  per record before mutations.

## Supported versions

Only the `main` branch receives security fixes. Deployments should track
recent `main` or tagged releases.
