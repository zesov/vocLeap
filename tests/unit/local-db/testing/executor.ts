import { Database } from "bun:sqlite";
import type { SqlExecutor, SqlStep } from "../../../lib/local-db/executor";

export type NodeExecutor = SqlExecutor & { raw: Database };

/**
 * In-memory executor for unit tests, running the exact SQL the browser runs.
 * Backed by `bun:sqlite` because better-sqlite3 (Node ABI) crashes Bun's NAPI
 * bridge; the SQL dialect is identical for this app's usage.
 */
export function createNodeExecutor(): NodeExecutor {
  const raw = new Database(":memory:");

  const bind = (params: unknown[]): unknown[] =>
    params.map((param) => (param === undefined ? null : param));

  const executor: SqlExecutor = {
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).all(...bind(params)) as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      const info = raw.prepare(sql).run(...bind(params));
      return { changes: Number(info.changes) };
    },
    async exec(sql: string) {
      raw.exec(sql);
    },
    async batch(steps: SqlStep[]) {
      raw.transaction(() => {
        for (const step of steps) {
          raw.prepare(step.sql).run(...bind(step.params ?? []));
        }
      })();
    },
  };

  return Object.assign(executor, { raw });
}
