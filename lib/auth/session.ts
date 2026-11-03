import { cookies } from "next/headers";
import { connection } from "next/server";
import { createHash, randomBytes } from "crypto";
import { db, initDatabase } from "@/lib/db/init";
import { SESSION_COOKIE } from "./cookies";

export { SESSION_COOKIE };

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionUser = {
  id: number;
  email: string;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: number): Promise<void> {
  await initDatabase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db
    .prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)")
    .run(userId, hashToken(token), expiresAt.toISOString());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  // Reading the session compares an expiry against the current time, so this can
  // never be prerendered. Stop prerendering here rather than letting `Date.now()`
  // be evaluated while building the static shell.
  await connection();

  await initDatabase();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);
  const row = await db
    .prepare(
      `SELECT u.id AS id, u.email AS email, s.expires_at AS expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash);

  if (!row) return null;

  const expiresAt = new Date(String(row.expires_at));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }

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
}