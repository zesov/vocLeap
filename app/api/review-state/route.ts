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
        // Return the latest position per word across all devices — but only
        // for words that can actually appear in the current queue.
        //
        // The client uses these positions solely to restore the ordering of
        // the queue fetched from /api/reviews (capped at `limit` words), so
        // this query mirrors the queue's WHERE/ORDER/LIMIT (see getDueReviews
        // / getNewWords in operations.ts). Positions for words outside the
        // queue are never used for ordering, so shipping them only bloated
        // the payload (~300 states for a single user) and delayed the
        // blocking state fetch on the review page.
        const limitParam = Number.parseInt(searchParams.get("limit") || "50", 10);
        const limit = Math.max(
          1,
          Math.min(Number.isFinite(limitParam) ? limitParam : 50, 100)
        );

        const db = (await import("@/lib/db/init")).db;
        const queueFilter =
          mode === "new"
            ? "AND r.word_id IS NULL"
            : "AND r.word_id IS NOT NULL AND r.next_review_date <= datetime('now')";
        // The sort key lives on words/reviews inside the subquery; expose it
        // as a column so the outer ORDER BY (which cannot reference `r`/`w`)
        // can use it.
        const queueKey =
          mode === "new" ? "w.created_at AS queue_order" : "r.next_review_date AS queue_order";
        const queueDir = mode === "new" ? "DESC" : "ASC";
        const stmt = db.prepare(`
          SELECT word_id, position, device_id, updated_at
          FROM (
            SELECT
              s.word_id,
              s.position,
              s.device_id,
              s.updated_at,
              ${queueKey},
              ROW_NUMBER() OVER (
                PARTITION BY s.word_id
                ORDER BY s.updated_at DESC, s.device_id ASC
              ) AS row_num
            FROM user_review_state s
            JOIN words w ON w.id = s.word_id
            LEFT JOIN reviews r ON r.word_id = s.word_id
            WHERE s.user_id = ? AND s.mode = ? AND w.user_id = ?
              ${queueFilter}
          )
          WHERE row_num = 1
          ORDER BY queue_order ${queueDir}
          LIMIT ?
        `);
        interface UserReviewStateRow {
          word_id: number;
          position: number;
          device_id: string;
          updated_at: string;
        }
        const rows = (await stmt.all(
          user.id,
          mode as "review" | "new",
          user.id,
          limit
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
