import { db, initDatabase } from "../lib/db/init.ts";

async function main() {
  await initDatabase();

  const result = await db
    .prepare(
      `DELETE FROM reviews
       WHERE last_reviewed IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM review_history rh WHERE rh.word_id = reviews.word_id
         )`
    )
    .run();

  console.log(`Removed ${result.changes} placeholder review rows.`);
}

main().catch((error) => {
  console.error("Reset failed:", error);
  process.exit(1);
});
