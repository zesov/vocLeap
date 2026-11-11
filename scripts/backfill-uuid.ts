import { createAdapter, describeDbTarget } from "../lib/db/adapter.ts";
import { uuidv7 } from "../lib/uuid.ts";

/**
 * Assigns UUIDv7s to rows created before the uuid columns existed.
 * Idempotent: reruns only touch rows where uuid IS NULL.
 *
 *   bun run backfill:uuid
 *   DB_MODE=turso TURSO_URL=... TURSO_AUTH_TOKEN=... bun run backfill:uuid
 */
const db = createAdapter();
console.log(`Backfilling UUIDs for: ${describeDbTarget()}`);

try {
  for (const table of ["words", "review_history"] as const) {
    const rows = await db
      .prepare(`SELECT id FROM ${table} WHERE uuid IS NULL ORDER BY id`)
      .all();
    for (const row of rows) {
      await db
        .prepare(`UPDATE ${table} SET uuid = ? WHERE id = ?`)
        .run(uuidv7(), row.id);
    }
    console.log(`${table}: backfilled ${rows.length} row(s)`);
  }
} finally {
  await db.close();
}
