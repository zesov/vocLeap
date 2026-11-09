import { createAdapter, dbMode, type DatabaseAdapter } from "./adapter.ts";
import { ensureSchema } from "./schema.ts";

export type { DBMode, DatabaseAdapter, PreparedStatement, ResultMeta } from "./adapter";

export const db: DatabaseAdapter = createAdapter();

let initPromise: Promise<void> | null = null;

/**
 * Local mode only: converge the schema once per process so `next dev` needs no
 * manual step (in-process, effectively free).
 *
 * Turso mode is a deliberate NO-OP: the schema is migrated explicitly with
 * `bun run migrate` (scripts/migrate.ts), never in the request path — a
 * serverless cold start must not pay DB round trips for schema checks.
 */
export function initDatabase(): Promise<void> {
  if (dbMode() !== "local") return Promise.resolve();

  if (!initPromise) {
    initPromise = ensureSchema(db).then(
      () => undefined,
      (error) => {
        // Allow the next request to retry instead of caching the failure forever.
        initPromise = null;
        throw error;
      }
    );
  }
  return initPromise;
}

initDatabase().catch((error) => {
  console.error("Database schema initialisation failed:", error);
});
