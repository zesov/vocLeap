import { mkdirSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
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
  prepare(sql: string): PreparedStatement;
  close(): Promise<void>;
}

class LocalStatement implements PreparedStatement {
  private stmt: Database.Statement;

  constructor(stmt: Database.Statement) {
    this.stmt = stmt;
  }

  async run(...params: unknown[]): Promise<ResultMeta> {
    const info = this.stmt.run(...params);
    return {
      changes: info.changes,
      lastInsertRowid:
        info.lastInsertRowid === null || info.lastInsertRowid === undefined
          ? null
          : (Number(info.lastInsertRowid) | 0),
    };
  }

  async get(...params: unknown[]): Promise<Record<string, unknown> | null> {
    const row = this.stmt.get(...params);
    return row ? (row as Record<string, unknown>) : null;
  }

  async all(...params: unknown[]): Promise<Record<string, unknown>[]> {
    return (this.stmt.all(...params) as unknown as Record<string, unknown>[]);
  }
}

class LocalAdapter implements DatabaseAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async batch(statements: string[]): Promise<void> {
    const runAll = this.db.transaction(() => {
      for (const sql of statements) {
        this.db.exec(sql);
      }
    });
    runAll();
  }

  prepare(sql: string): PreparedStatement {
    return new LocalStatement(this.db.prepare(sql));
  }

  async close(): Promise<void> {
    this.db.close();
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
    const url =
      process.env.TURSO_URL ||
      "libsql://vocleap-vocleap.aws-ap-southeast-1.turso.io";
    const authToken = process.env.TURSO_AUTH_TOKEN;
    this.client = createClient({ url, authToken });
  }

  async exec(sql: string): Promise<void> {
    await this.client.execute({ sql });
  }

  async batch(statements: string[]): Promise<void> {
    await this.client.batch(statements, "write");
  }

  prepare(sql: string): PreparedStatement {
    return new TursoStatement(this.client, sql);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

const DB_MODE = (process.env.DB_MODE || "local") as DBMode;

let adapter: DatabaseAdapter;

if (DB_MODE === "turso") {
  adapter = new TursoAdapter();
} else {
  const DB_PATH = process.env.DB_PATH || "./data/vocleap.db";
  mkdirSync(dirname(DB_PATH), { recursive: true });
  adapter = new LocalAdapter(DB_PATH);
}

export const db = adapter;

export async function initDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL UNIQUE,
      translation TEXT NOT NULL,
      definitions TEXT,
      examples TEXT,
      phonetic TEXT,
      audio_url TEXT,
      source_language TEXT DEFAULT 'en',
      target_language TEXT DEFAULT 'zh-CN',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      ease_factor REAL NOT NULL DEFAULT 2.5,
      interval INTEGER NOT NULL DEFAULT 0,
      repetitions INTEGER NOT NULL DEFAULT 0,
      next_review_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_reviewed DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(word_id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS review_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL,
      previous_ease_factor REAL NOT NULL,
      previous_interval INTEGER NOT NULL,
      previous_repetitions INTEGER NOT NULL,
      new_ease_factor REAL NOT NULL,
      new_interval INTEGER NOT NULL,
      new_repetitions INTEGER NOT NULL,
      reviewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_reviews_next_review ON reviews(next_review_date)`
  );
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_words_word ON words(word)`);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_review_history_word ON review_history(word_id)`
  );
}

initDatabase();
