import { db } from "@/lib/db/init";
import type { SessionUser } from "./session";

export async function claimLegacyWords(user: SessionUser): Promise<number> {
  const ownerEmail = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
  if (!ownerEmail) return 0;
  if (user.email.trim().toLowerCase() !== ownerEmail) return 0;

  const usersRow = await db.prepare("SELECT COUNT(*) AS count FROM users").get();
  if (Number(usersRow?.count ?? 0) !== 1) return 0;

  const result = await db
    .prepare("UPDATE words SET user_id = ? WHERE user_id IS NULL")
    .run(user.id);

  return result.changes;
}