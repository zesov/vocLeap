import { NextRequest, NextResponse } from "next/server";
import { getReviewSession, upsertReviewSession } from "@/lib/db/operations";
import { withUser } from "@/lib/auth/guard";

export async function GET(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { searchParams } = new URL(request.url);
      const queue = searchParams.get("queue");
      const deviceId = searchParams.get("deviceId");

      if (!queue || !["due", "new"].includes(queue)) {
        return NextResponse.json({ error: "queue must be 'due' or 'new'" }, { status: 400 });
      }
      if (!deviceId) {
        return NextResponse.json({ error: "deviceId required" }, { status: 400 });
      }

      const session = await getReviewSession(user.id, deviceId, queue as "due" | "new");
      if (!session) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      return NextResponse.json({
        deviceId: session.deviceId,
        queueType: session.queueType,
        queueWordIds: session.queueWordIds,
        currentIndex: session.currentIndex,
        stats: session.stats,
        updatedAt: session.updatedAt,
      });
    } catch (e) {
      console.error("GET review-state error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}

export async function POST(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const body = await request.json();

      const { deviceId, queueType, queueWordIds, currentIndex, stats } = body;

      if (!deviceId || !queueType || !Array.isArray(queueWordIds) || typeof currentIndex !== "number" || !stats) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
      }
      if (!["due", "new"].includes(queueType)) {
        return NextResponse.json({ error: "queueType must be 'due' or 'new'" }, { status: 400 });
      }

      await upsertReviewSession({
        userId: user.id,
        deviceId,
        queueType,
        queueWordIds,
        currentIndex,
        stats,
      });

      return NextResponse.json({ ok: true, updatedAt: new Date().toISOString() });
    } catch (e) {
      console.error("POST review-state error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
