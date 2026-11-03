import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db/init";
import { hashPassword } from "@/lib/auth/password";
import { createSession, type SessionUser } from "@/lib/auth/session";
import { normalizeEmail, validatePassword } from "@/lib/auth/validation";
import { badOriginResponse, isSameOrigin } from "@/lib/auth/csrf";
import { clientKey, throttle } from "@/lib/auth/rate-limit";
import { claimLegacyWords } from "@/lib/auth/claim";

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/i.test(error.message)
  );
}

export async function POST(request: NextRequest) {
  try {
    if (!isSameOrigin(request)) return badOriginResponse();

    await initDatabase();

    const body = await request.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const password = validatePassword(body?.password);

    if (!email || !password) {
      return NextResponse.json(
        {
          error:
            "Enter a valid email and a password of at least 8 characters",
        },
        { status: 400 }
      );
    }

    const limit = throttle(clientKey(request, email));
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: "Too many attempts. Try again later.",
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        { status: 429 }
      );
    }

    const existing = await db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email);
    if (existing) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(password);
    const result = await db
      .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(email, passwordHash);

    const user: SessionUser = {
      id: Number(result.lastInsertRowid),
      email,
    };

    await createSession(user.id);
    await claimLegacyWords(user);

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 }
      );
    }
    console.error("Signup error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}