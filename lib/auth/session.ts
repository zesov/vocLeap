import { cookies } from "next/headers";
import { connection } from "next/server";
import { createHash, randomBytes } from "crypto";
import { db, initDatabase } from "@/lib/db/init";
import { SESSION_COOKIE } from "./cookies";

export { SESSION_COOKIE };

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Cache session for 5 minutes to avoid DB queries on every request
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_CACHE_COOKIE = "vocleap_session_cache";

export type SessionUser = {
  id: number;
  email: string;
};

interface CachedSession {
  user: SessionUser;
  expiresAt: number; // Unix timestamp in ms
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCacheCookie(value: string | undefined): CachedSession | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as CachedSession;
    if (!parsed.user || !parsed.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isCacheValid(cache: CachedSession | null): boolean {
  if (!cache) return false;
  return Date.now() < cache.expiresAt;
}

export async function createSession(user: SessionUser): Promise<void> {
  await initDatabase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db
    .prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)")
    .run(user.id, hashToken(token), expiresAt.toISOString());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });

  // Also set cache cookie with user data
  const cacheValue: CachedSession = {
    user,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  };
  store.set(SESSION_CACHE_COOKIE, JSON.stringify(cacheValue), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_CACHE_TTL_MS / 1000,
  });
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  // Reading the session compares an expiry against the current time, so this
  // must render at request time. `connection()` marks this as dynamic and
  // prevents Next.js from evaluating `Date.now()` while prerendering the
  // static shell.
  await connection();

  // Check session cache first (5 min TTL)
  const store = await cookies();
  const cache = parseCacheCookie(store.get(SESSION_CACHE_COOKIE)?.value);

  if (cache && isCacheValid(cache)) {
    return cache.user;
  }

  // Cache miss or expired - validate session against database
  await initDatabase();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const row = await db
    .prepare(
      `SELECT u.id AS id, u.email AS email, s.expires_at AS expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash);

  if (!row) {
    return null;
  }

  const expiresAt = new Date(String(row.expires_at));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }

  // Note: We don't update the cache cookie here because getCurrentUser can be called
  // from Server Components (layouts, pages) where cookies() is read-only.
  // The cache is refreshed by the login/signup route handlers via createSession().
  // After 5 minutes, this naturally falls back to a DB query, which is acceptable.
  return { id: Number(row.id), email: String(row.email) };
}

export async function destroySession(): Promise<void> {
  await initDatabase();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    await db
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(hashToken(token));
  }

  store.delete(SESSION_COOKIE);
  store.delete(SESSION_CACHE_COOKIE);
}