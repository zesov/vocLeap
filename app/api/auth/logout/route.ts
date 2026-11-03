import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/auth/session";
import { badOriginResponse, isSameOrigin } from "@/lib/auth/csrf";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return badOriginResponse();

  await destroySession();
  return new NextResponse(null, { status: 204 });
}