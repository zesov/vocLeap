import { NextRequest, NextResponse } from "next/server";
import { 
  getUserReviewState, 
  upsertUserReviewStates,
  clearUserReviewState,
  getUserReviewMeta,
  upsertUserReviewMeta
} from "@/lib/db/operations";
import { withUser } from "@/lib/auth/guard";

export async function GET(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { searchParams } = new URL(request.url);
      const mode = searchParams.get("mode");
      const deviceId = searchParams.get("deviceId");
      const allDevices = searchParams.get("allDevices") === "true";

      if (!mode || !["review", "new"].includes(mode)) {
        return NextResponse.json({ error: "mode must be 'review' or 'new'" }, { status: 400 });
      }
      if (!deviceId && !allDevices) {
        return NextResponse.json({ error: "deviceId required" }, { status: 400 });
      }

      if (allDevices) {
        // Return merged state across all devices (for testing/debugging)
        // Need to use db directly since we don't have a multi-device query function
        const db = (await import("@/lib/db/init")).db;
        const stmt = db.prepare(`
          SELECT * FROM user_review_state
          WHERE user_id = ? AND mode = ?
          ORDER BY updated_at DESC
        `);
        interface UserReviewStateRow {
          user_id: number;
          device_id: string;
          mode: "review" | "new";
          word_id: number;
          position: number;
          updated_at: string;
        }
        const rows = (await stmt.all(user.id, mode as "review" | "new")) as unknown as UserReviewStateRow[];
        const states = rows.map((r) => ({
          wordId: r.word_id,
          position: r.position,
          deviceId: r.device_id,
          updatedAt: r.updated_at,
        }));

        // Get meta from the device with the latest updated_at
        let meta: { currentIndex: number; reviewedCount: number; updatedAt: string } | null = null;
        if (rows.length > 0) {
          // Get unique device_ids from the states
          const deviceIds = [...new Set(rows.map(r => r.device_id))];
          for (const deviceId of deviceIds) {
            const metaResult = await getUserReviewMeta(user.id, deviceId, mode as "review" | "new");
            if (metaResult) {
              if (!meta || metaResult.updatedAt > meta.updatedAt) {
                meta = metaResult;
              }
            }
          }
        }

        return NextResponse.json({ mode, states, meta });
      }

      const [states, meta] = await Promise.all([
        getUserReviewState(user.id, deviceId!, mode as "review" | "new"),
        getUserReviewMeta(user.id, deviceId!, mode as "review" | "new"),
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

      const { deviceId, mode, states, meta } = body;

      if (!deviceId) {
        return NextResponse.json({ error: "deviceId required" }, { status: 400 });
      }
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
      const deviceId = searchParams.get("deviceId");

      if (!mode || !["review", "new"].includes(mode)) {
        return NextResponse.json({ error: "mode must be 'review' or 'new'" }, { status: 400 });
      }
      if (!deviceId) {
        return NextResponse.json({ error: "deviceId required" }, { status: 400 });
      }

      await clearUserReviewState(user.id, deviceId, mode as "review" | "new");

      return NextResponse.json({ ok: true });
    } catch (e) {
      console.error("DELETE review-state error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
