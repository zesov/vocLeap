import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db/init";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, type SessionUser } from "@/lib/auth/session";
import { normalizeEmail } from "@/lib/auth/validation";
import { badOriginResponse, isSameOrigin } from "@/lib/auth/csrf";
import { clientKey, throttle } from "@/lib/auth/rate-limit";
import { claimLegacyWords } from "@/lib/auth/claim";

export async function POST(request: NextRequest) {
  try {
    if (!isSameOrigin(request)) return badOriginResponse();

    await initDatabase();

    const body = await request.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === "string" ? body.password : null;

    if (!email || !password) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
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

    const row = await db
      .prepare(
        "SELECT id, email, password_hash FROM users WHERE email = ?"
      )
      .get(email);

    const valid =
      row !== null &&
      (await verifyPassword(password, String(row.password_hash)));

    if (!valid || !row) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    const user: SessionUser = {
      id: Number(row.id),
      email: String(row.email),
    };

    await createSession(user.id);
    await claimLegacyWords(user);

    return NextResponse.json({ user });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}