import { NextRequest, NextResponse } from "next/server";

export function isSameOrigin(request: NextRequest): boolean {
  if (process.env.NODE_ENV === "development") return true;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === request.nextUrl.origin;
}

export function badOriginResponse(): NextResponse {
  return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
}
