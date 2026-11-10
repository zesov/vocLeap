import type { SqlExecutor } from "./executor";

export const LOCAL_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS words (
  uuid TEXT PRIMARY KEY,
  server_id INTEGER,
  word TEXT NOT NULL,
  translation TEXT NOT NULL,
  definitions TEXT,
  examples TEXT,
  phonetic TEXT,
  audio_url TEXT,
  source_language TEXT NOT NULL DEFAULT 'en',
  target_language TEXT NOT NULL DEFAULT 'zh-CN',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_words_word
  ON words(word) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_local_words_server_id ON words(server_id);

CREATE TABLE IF NOT EXISTS reviews (
  word_uuid TEXT PRIMARY KEY,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  interval INTEGER NOT NULL DEFAULT 0,
  repetitions INTEGER NOT NULL DEFAULT 0,
  next_review_date TEXT NOT NULL,
  last_reviewed TEXT,
  stability REAL,
  difficulty REAL,
  fsrs_state INTEGER,
  lapses INTEGER,
  fsrs_reps INTEGER,
  fsrs_last_review TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_reviews_due ON reviews(next_review_date);

CREATE TABLE IF NOT EXISTS review_history (
  uuid TEXT PRIMARY KEY,
  word_uuid TEXT NOT NULL,
  rating INTEGER NOT NULL,
  previous_ease_factor REAL NOT NULL,
  previous_interval INTEGER NOT NULL,
  previous_repetitions INTEGER NOT NULL,
  new_ease_factor REAL NOT NULL,
  new_interval INTEGER NOT NULL,
  new_repetitions INTEGER NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'sm2',
  snapshot TEXT,
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_history_word ON review_history(word_uuid);
CREATE INDEX IF NOT EXISTS idx_local_history_reviewed
  ON review_history(reviewed_at DESC);

CREATE TABLE IF NOT EXISTS sync_ops (
  op_id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_ops_created ON sync_ops(created_at);

CREATE TABLE IF NOT EXISTS dict_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`;

/**
 * Creates the local schema and records its version. Future versions append to
 * `MIGRATIONS` keyed by the version they upgrade *from*.
 *
 * Note: foreign keys are intentionally NOT enabled locally. Pull pages can
 * deliver a review before its word (pagination is per entity), and orphan rows
 * are inert until the word arrives; enforcing FKs would reject valid pages.
 */
const MIGRATIONS: Record<number, string> = {
  // 1: initial schema (created by DDL above)
};

export async function migrateLocalSchema(db: SqlExecutor): Promise<void> {
  const rows = await db.all<{ user_version: number }>("PRAGMA user_version");
  const current = Number(rows[0]?.user_version ?? 0);

  if (current < 1) {
    await db.exec(DDL);
  }
  for (let version = Math.max(current, 1); version < LOCAL_SCHEMA_VERSION; version++) {
    const sql = MIGRATIONS[version];
    if (!sql) throw new Error(`Missing local migration from version ${version}`);
    await db.exec(sql);
  }
  await db.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
}

export async function getMeta(
  db: SqlExecutor,
  key: string
): Promise<string | null> {
  const rows = await db.all<{ value: string }>(
    "SELECT value FROM meta WHERE key = ?",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setMeta(
  db: SqlExecutor,
  key: string,
  value: string
): Promise<void> {
  await db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

export async function setMetaIfAbsent(
  db: SqlExecutor,
  key: string,
  value: string
): Promise<void> {
  await db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    [key, value]
  );
}
