import { Database } from "bun:sqlite";
import type {
  DatabaseAdapter,
  PreparedStatement,
  ResultMeta,
} from "./adapter";

export type TestAdapter = DatabaseAdapter & { raw: Database };

/**
 * better-sqlite3 is built against the Node ABI and crashes Bun's NAPI bridge,
 * so tests run on Bun's built-in SQLite instead. Same `DatabaseAdapter`
 * surface, in-memory, fresh per call.
 */
export function createTestAdapter(): TestAdapter {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");

  const adapter: DatabaseAdapter = {
    async exec(sql: string) {
      raw.exec(sql);
    },
    async batch(statements: string[]) {
      raw.transaction(() => {
        for (const sql of statements) raw.exec(sql);
      })();
    },
    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },
    prepare(sql: string): PreparedStatement {
      const stmt = raw.prepare(sql);
      const bind = (params: unknown[]): unknown[] =>
        params.map((param) => (param === undefined ? null : param));
      return {
        async run(...params: unknown[]): Promise<ResultMeta> {
          const info = stmt.run(...bind(params));
          return {
            changes: Number(info.changes),
            lastInsertRowid:
              info.lastInsertRowid === undefined
                ? null
                : Number(info.lastInsertRowid),
          };
        },
        async get(...params: unknown[]) {
          return (
            (stmt.get(...bind(params)) as Record<string, unknown> | null) ??
            null
          );
        },
        async all(...params: unknown[]) {
          return stmt.all(...bind(params)) as Record<string, unknown>[];
        },
      };
    },
    async close() {
      raw.close();
    },
  };

  return Object.assign(adapter, { raw });
}
