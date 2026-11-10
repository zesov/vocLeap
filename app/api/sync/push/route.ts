import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/auth/guard";
import { db } from "@/lib/db/init";
import { applyOps } from "@/lib/sync/server-apply";
import { MAX_PUSH_OPS, type SyncEntity, type SyncOp } from "@/lib/sync/types";

const ENTITIES: SyncEntity[] = ["word", "review", "history", "settings"];

function isSyncOp(value: unknown): value is SyncOp {
  if (typeof value !== "object" || value === null) return false;
  const op = value as Record<string, unknown>;
  return (
    typeof op.opId === "string" &&
    op.opId.length > 0 &&
    ENTITIES.includes(op.entity as SyncEntity) &&
    (op.op === "upsert" || op.op === "delete") &&
    typeof op.payload === "object" &&
    op.payload !== null
  );
}

export async function POST(request: NextRequest) {
  return withUser(async (user) => {
    const body = (await request.json().catch(() => null)) as {
      ops?: unknown;
    } | null;
    const ops = body?.ops;

    if (!Array.isArray(ops) || !ops.every(isSyncOp)) {
      return NextResponse.json({ error: "Invalid ops" }, { status: 400 });
    }
    if (ops.length > MAX_PUSH_OPS) {
      return NextResponse.json(
        { error: `At most ${MAX_PUSH_OPS} ops per request` },
        { status: 413 }
      );
    }

    try {
      const results = await applyOps(db, user.id, ops);
      return NextResponse.json({ results });
    } catch (error) {
      console.error("sync push error:", error);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
