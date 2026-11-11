import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/auth/guard";
import { db } from "@/lib/db/init";
import { decodeCursor } from "@/lib/sync/cursor";
import { pullPage } from "@/lib/sync/server-pull";

export async function GET(request: NextRequest) {
  return withUser(async (user) => {
    const cursor = decodeCursor(
      new URL(request.url).searchParams.get("cursor")
    );
    try {
      const page = await pullPage(db, user.id, cursor);
      return NextResponse.json(page, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      console.error("sync pull error:", error);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
