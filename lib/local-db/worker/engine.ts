import type { SqlStep } from "../executor";
import type { LocalDbMode } from "./protocol";

export interface WasmEngine {
  readonly mode: Exclude<LocalDbMode, "online">;
  readonly name: string;
  all<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  batch(statements: SqlStep[]): Promise<void>;
  close(): Promise<void>;
}

/** Thrown when another tab already owns the database. */
export class DbBusyError extends Error {
  constructor(message = "Database is locked by another tab") {
    super(message);
    this.name = "DbBusyError";
  }
}
