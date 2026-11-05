import { NextRequest, NextResponse } from "next/server";
import {
  getUserReviewState,
  replaceUserReviewStates,
  clearUserReviewState,
  clearUserReviewMeta,
  getUserReviewMeta,
  upsertUserReviewMeta
} from "@/lib/db/operations";
import { initDatabase } from "@/lib/db/init";
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
        // Return the latest position per word across all devices.
        //
        // The table is keyed by (user_id, device_id, mode, word_id), so a word
        // the user has ever seen on more than one browser/device appears once
        // per device. Returning every row made this endpoint ship ~2k mostly
        // redundant states (~220 KB) for a single user, even though the client
        // only keeps the newest row per word.
        const db = (await import("@/lib/db/init")).db;
        const stmt = db.prepare(`
          SELECT word_id, position, device_id, updated_at
          FROM (
            SELECT
              word_id,
              position,
              device_id,
              updated_at,
              ROW_NUMBER() OVER (
                PARTITION BY word_id
                ORDER BY updated_at DESC, device_id ASC
              ) AS row_num
            FROM user_review_state
            WHERE user_id = ? AND mode = ?
          )
          WHERE row_num = 1
          ORDER BY position ASC
        `);
        interface UserReviewStateRow {
          word_id: number;
          position: number;
          device_id: string;
          updated_at: string;
        }
        const rows = (await stmt.all(
          user.id,
          mode as "review" | "new"
        )) as unknown as UserReviewStateRow[];
        const states = rows.map((r) => ({
          wordId: r.word_id,
          position: r.position,
          deviceId: r.device_id,
          updatedAt: r.updated_at,
        }));

        // Pick the newest session meta across devices in a single query,
        // instead of one lookup per device.
        const metaStmt = db.prepare(`
          SELECT current_index, reviewed_count, updated_at
          FROM user_review_meta
          WHERE user_id = ? AND mode = ?
          ORDER BY updated_at DESC
          LIMIT 1
        `);
        const metaRow = await metaStmt.get(
          user.id,
          mode as "review" | "new"
        );
        const meta = metaRow
          ? {
              currentIndex: Number(metaRow.current_index),
              reviewedCount: Number(metaRow.reviewed_count),
              updatedAt: String(metaRow.updated_at),
            }
          : null;

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
  await initDatabase();
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
        // Replace this device's slice so words that have left the queue stop
        // accumulating in user_review_state.
        await replaceUserReviewStates(
          user.id,
          deviceId,
          mode as "review" | "new",
          validStates
        );
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
  await initDatabase();
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
      await clearUserReviewMeta(user.id, deviceId, mode as "review" | "new");

      return NextResponse.json({ ok: true });
    } catch (e) {
      console.error("DELETE review-state error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
