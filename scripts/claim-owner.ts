import { db, initDatabase } from "../lib/db/init.ts";

async function main() {
  const email = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--email="))
    ?.slice("--email=".length)
    .trim()
    .toLowerCase();

  if (!email) {
    console.error("Usage: bun run claim-owner --email=you@example.com");
    process.exit(1);
  }

  await initDatabase();

  const user = await db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) {
    console.error(`No user with email ${email}. Sign up first.`);
    process.exit(1);
  }

  const result = await db
    .prepare("UPDATE words SET user_id = ? WHERE user_id IS NULL")
    .run(Number(user.id));

  console.log(`Claimed ${result.changes} words for ${email}.`);
}

main().catch((error) => {
  console.error("Claim failed:", error);
  process.exit(1);
});