import { createAdapter, describeDbTarget } from "../lib/db/adapter.ts";
import { ensureSchema } from "../lib/db/schema.ts";

/**
 * Explicit schema migration. Run with:
 *
 *   bun run migrate
 *   # or against Turso:
 *   DB_MODE=turso TURSO_URL=... TURSO_AUTH_TOKEN=... bun run migrate
 *
 * Idempotent: inspects the schema in one query and only runs the missing DDL
 * as a single atomic batch. Safe to run repeatedly.
 */

const target = describeDbTarget();
console.log(`Migrating schema for: ${target}`);

const db = createAdapter();

try {
  const report = await ensureSchema(db);
  if (!report.changed) {
    console.log("Schema already up to date. Nothing to do.");
  } else if (report.statements >= 0) {
    console.log(
      `Done. Executed ${report.statements} DDL statement(s) in one batch.`
    );
  } else {
    console.log(
      "Done. Applied base DDL + best-effort column migrations (inspection unavailable)."
    );
  }
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}
