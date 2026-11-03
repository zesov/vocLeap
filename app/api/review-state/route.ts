import { NextRequest, NextResponse } from "next/server";
import { 
  getUserReviewState, 
  upsertUserReviewStates,
  clearUserReviewState,
  getUserReviewMeta,
  upsertUserReviewMeta
} from "@/lib/db/operations";
import { withUser } from "@/lib/auth/guard";

function getDeviceId(request: NextRequest): string {
  // Get deviceId from header, fallback to a cookie, or generate a session-based one
  const headerDeviceId = request.headers.get("x-device-id");
  if (headerDeviceId) return headerDeviceId;
  
  const cookieDeviceId = request.cookies.get("device_id")?.value;
  if (cookieDeviceId) return cookieDeviceId;
  
  // Fallback: use user agent + IP hash or a random ID for this session
  // In production, you'd want a proper device fingerprint
  const ua = request.headers.get("user-agent") || "unknown";
  return `device_${Buffer.from(ua).toString("base64").slice(0, 16)}`;
}

export async function GET(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { searchParams } = new URL(request.url);
      const mode = searchParams.get("mode");
      const deviceId = getDeviceId(request);

      if (!mode || !["review", "new"].includes(mode)) {
        return NextResponse.json({ error: "mode must be 'review' or 'new'" }, { status: 400 });
      }

      const [states, meta] = await Promise.all([
        getUserReviewState(user.id, deviceId, mode as "review" | "new"),
        getUserReviewMeta(user.id, deviceId, mode as "review" | "new"),
      ]);
      
      return NextResponse.json({
        mode,
        deviceId,
        states: states.map(s => ({
          wordId: s.wordId,
          position: s.position,
          updatedAt: s.updatedAt,
        })),
        meta: meta ? {
          currentIndex: meta.currentIndex,
          reviewedCount: meta.reviewedCount,
          updatedAt: meta.updatedAt,
        } : null,
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
      const deviceId = getDeviceId(request);

      const { mode, states, meta } = body;

      if (!mode || !["review", "new"].includes(mode)) {
        return NextResponse.json({ error: "mode must be 'review' or 'new'" }, { status: 400 });
      }
      if (!Array.isArray(states)) {
        return NextResponse.json({ error: "states array required" }, { status: 400 });
      }

      const validStates = states
        .filter(s => typeof s.wordId === "number" && typeof s.position === "number")
        .map(s => ({
          userId: user.id,
          deviceId,
          mode: mode as "review" | "new",
          wordId: s.wordId,
          position: s.position,
          updatedAt: s.updatedAt || new Date().toISOString(),
        }));

      if (validStates.length > 0) {
        await upsertUserReviewStates(validStates);
      }

      // Save session meta (currentIndex, reviewedCount)
      if (meta && typeof meta.currentIndex === "number" && typeof meta.reviewedCount === "number") {
        await upsertUserReviewMeta(user.id, deviceId, mode as "review" | "new", meta.currentIndex, meta.reviewedCount);
      }

      return NextResponse.json({ ok: true, updatedAt: new Date().toISOString() });
    } catch (e) {
      console.error("POST review-state error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}

export async function DELETE(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { searchParams } = new URL(request.url);
      const mode = searchParams.get("mode");
      const deviceId = getDeviceId(request);

      if (!mode || !["review", "new"].includes(mode)) {
        return NextResponse.json({ error: "mode must be 'review' or 'new'" }, { status: 400 });
      }

      await clearUserReviewState(user.id, deviceId, mode as "review" | "new");

      return NextResponse.json({ ok: true });
    } catch (e) {
      console.error("DELETE review-state error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
