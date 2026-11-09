import { mkdirSync } from "fs";
import { dirname } from "path";
import type Database from "better-sqlite3";
import { createClient, type InValue } from "@libsql/client";

export type DBMode = "local" | "turso";

export interface ResultMeta {
  changes: number;
  lastInsertRowid: number | null;
}

export interface PreparedStatement {
  run(...params: unknown[]): Promise<ResultMeta>;
  get(...params: unknown[]): Promise<Record<string, unknown> | null>;
  all(...params: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface DatabaseAdapter {
  exec(sql: string): Promise<void>;
  batch(statements: string[]): Promise<void>;
  transaction<T>(fn: () => T): T;
  prepare(sql: string): PreparedStatement;
  close(): Promise<void>;
}

export const DEFAULT_TURSO_URL =
  "libsql://your-database-your-org.turso.io";

class LocalStatement implements PreparedStatement {
  private getDb: () => Promise<Database.Database>;
  private sql: string;

  constructor(getDb: () => Promise<Database.Database>, sql: string) {
    this.getDb = getDb;
    this.sql = sql;
  }

  private async prepare(): Promise<Database.Statement> {
    return (await this.getDb()).prepare(this.sql);
  }

  async run(...params: unknown[]): Promise<ResultMeta> {
    const info = (await this.prepare()).run(...params);
    return {
      changes: info.changes,
      lastInsertRowid:
        info.lastInsertRowid === null || info.lastInsertRowid === undefined
          ? null
          : (Number(info.lastInsertRowid) | 0),
    };
  }

  async get(...params: unknown[]): Promise<Record<string, unknown> | null> {
    const row = (await this.prepare()).get(...params);
    return row ? (row as Record<string, unknown>) : null;
  }

  async all(...params: unknown[]): Promise<Record<string, unknown>[]> {
    return ((await this.prepare()).all(...params) as unknown as Record<string, unknown>[]);
  }
}

class LocalAdapter implements DatabaseAdapter {
  // better-sqlite3 is a native module; load it lazily on first use so
  // serverless deployments running in Turso mode never bundle/dlopen it.
  private dbPromise: Promise<Database.Database>;
  private loadedDb: Database.Database | null = null;

  constructor(dbPath: string) {
    this.dbPromise = import("better-sqlite3").then(({ default: DatabaseCtor }) => {
      const db = new DatabaseCtor(dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      this.loadedDb = db;
      return db;
    });
  }

  private getDb(): Promise<Database.Database> {
    return this.dbPromise;
  }

  async exec(sql: string): Promise<void> {
    (await this.getDb()).exec(sql);
  }

  async batch(statements: string[]): Promise<void> {
    const db = await this.getDb();
    const runAll = db.transaction(() => {
      for (const sql of statements) {
        db.exec(sql);
      }
    });
    runAll();
  }

  transaction<T>(fn: () => T): T {
    if (!this.loadedDb) {
      throw new Error("Local database not initialised yet; run a query first");
    }
    const tx = this.loadedDb.transaction(fn);
    return tx();
  }

  prepare(sql: string): PreparedStatement {
    return new LocalStatement(() => this.getDb(), sql);
  }

  async close(): Promise<void> {
    (await this.getDb()).close();
  }
}

class TursoStatement implements PreparedStatement {
  private client: ReturnType<typeof createClient>;
  private sql: string;

  constructor(client: ReturnType<typeof createClient>, sql: string) {
    this.client = client;
    this.sql = sql;
  }

  async run(...params: unknown[]): Promise<ResultMeta> {
    const result = await this.client.execute({
      sql: this.sql,
      args: params as InValue[],
    });
    return {
      changes: result.rowsAffected,
      lastInsertRowid:
        result.lastInsertRowid === undefined
          ? null
          : Number(result.lastInsertRowid),
    };
  }

  async get(...params: unknown[]): Promise<Record<string, unknown> | null> {
    const result = await this.client.execute({
      sql: this.sql,
      args: params as InValue[],
    });
    return result.rows[0] ?? null;
  }

  async all(...params: unknown[]): Promise<Record<string, unknown>[]> {
    const result = await this.client.execute({
      sql: this.sql,
      args: params as InValue[],
    });
    return result.rows;
  }
}

class TursoAdapter implements DatabaseAdapter {
  private client: ReturnType<typeof createClient>;

  constructor() {
    const url = process.env.TURSO_URL || DEFAULT_TURSO_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    this.client = createClient({ url, authToken });
  }

  async exec(sql: string): Promise<void> {
    await this.client.execute({ sql });
  }

  async batch(statements: string[]): Promise<void> {
    await this.client.batch(statements, "write");
  }

  transaction<T>(fn: () => T): T {
    // Turso doesn't support transactions in the same way, but batch can be used
    // For now, execute synchronously - in practice, Turso batch is atomic
    return fn();
  }

  prepare(sql: string): PreparedStatement {
    return new TursoStatement(this.client, sql);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export function dbMode(): DBMode {
  return (process.env.DB_MODE || "local") as DBMode;
}

export function createAdapter(): DatabaseAdapter {
  if (dbMode() === "turso") {
    return new TursoAdapter();
  }
  const DB_PATH = process.env.DB_PATH || "./data/vocleap.db";
  mkdirSync(dirname(DB_PATH), { recursive: true });
  return new LocalAdapter(DB_PATH);
}

/** Human-readable description of the configured database, for scripts/logs. */
export function describeDbTarget(): string {
  if (dbMode() === "turso") {
    return `Turso (${process.env.TURSO_URL || DEFAULT_TURSO_URL})`;
  }
  return `local SQLite (${process.env.DB_PATH || "./data/vocleap.db"})`;
}
