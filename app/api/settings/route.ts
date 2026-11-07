import { NextRequest, NextResponse } from "next/server";
import {
  getUserAlgorithm,
  setUserAlgorithm,
  type SrsAlgorithm,
} from "@/lib/db/operations";
import { withUser } from "@/lib/auth/guard";

export async function GET() {
  return withUser(async (user) => {
    try {
      const srsAlgorithm = await getUserAlgorithm(user.id);
      return NextResponse.json({ srsAlgorithm });
    } catch (e) {
      console.error("GET settings error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}

export async function PUT(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const body = await request.json();
      const algorithm = body?.srsAlgorithm;
      if (algorithm !== "sm2" && algorithm !== "fsrs") {
        return NextResponse.json(
          { error: "srsAlgorithm must be 'sm2' or 'fsrs'" },
          { status: 400 }
        );
      }
      await setUserAlgorithm(user.id, algorithm as SrsAlgorithm);
      return NextResponse.json({ srsAlgorithm: algorithm });
    } catch (e) {
      console.error("PUT settings error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
