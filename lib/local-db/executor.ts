/** One statement inside an atomic batch. */
export interface SqlStep {
  sql: string;
  params?: unknown[];
}

/**
 * The only SQL surface the local database code sees. Implemented by the
 * test executor and by the Worker RPC client, so every query in
 * `lib/local-db/**` runs identically in tests and in the browser.
 */
export interface SqlExecutor {
  all<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Multi-statement DDL (no parameters). */
  exec(sql: string): Promise<void>;
  /** Runs every step inside one transaction; rolls back on any failure. */
  batch(steps: SqlStep[]): Promise<void>;
}
