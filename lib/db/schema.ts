import type { DatabaseAdapter } from "./adapter.ts";

export interface SchemaMigrationReport {
  /** True when at least one DDL statement was executed. */
  changed: boolean;
  /** Number of DDL statements executed (0 when already up to date). */
  statements: number;
}

/**
 * Everything the schema migration needs to decide, fetched in ONE round trip.
 * On a remote backend (Turso) every statement is an HTTP request, so checking
 * tables, columns, and indexes separately would cost a round trip each.
 */
const SCHEMA_INSPECT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'user_review_meta') AS has_user_review_meta,
    (SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'srs_algorithm') AS users_srs_algorithm,
    (SELECT COUNT(*) FROM pragma_table_info('reviews') WHERE name = 'stability') AS reviews_stability,
    (SELECT COUNT(*) FROM pragma_table_info('reviews') WHERE name = 'difficulty') AS reviews_difficulty,
    (SELECT COUNT(*) FROM pragma_table_info('reviews') WHERE name = 'fsrs_state') AS reviews_fsrs_state,
    (SELECT COUNT(*) FROM pragma_table_info('reviews') WHERE name = 'lapses') AS reviews_lapses,
    (SELECT COUNT(*) FROM pragma_table_info('reviews') WHERE name = 'fsrs_reps') AS reviews_fsrs_reps,
    (SELECT COUNT(*) FROM pragma_table_info('reviews') WHERE name = 'fsrs_last_review') AS reviews_fsrs_last_review,
    (SELECT COUNT(*) FROM pragma_table_info('review_history') WHERE name = 'algorithm') AS review_history_algorithm,
    (SELECT COUNT(*) FROM pragma_table_info('review_history') WHERE name = 'snapshot') AS review_history_snapshot,
    (SELECT COUNT(*) FROM pragma_table_info('words') WHERE name = 'user_id') AS words_user_id,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'words') AS has_words_table,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_review_state_mode') AS idx_user_review_state_mode,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_review_meta_user') AS idx_user_review_meta_user,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_expires') AS idx_sessions_expires,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_words_word') AS idx_words_word,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_reviews_next_review') AS idx_reviews_next_review,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_history_word') AS idx_review_history_word,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_history_reviewed') AS idx_review_history_reviewed,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_words_user') AS idx_words_user,
    (SELECT COUNT(*) FROM pragma_table_info('words') WHERE name = 'uuid') AS words_uuid,
    (SELECT COUNT(*) FROM pragma_table_info('words') WHERE name = 'deleted_at') AS words_deleted_at,
    (SELECT COUNT(*) FROM pragma_table_info('review_history') WHERE name = 'uuid') AS review_history_uuid,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_words_uuid') AS idx_words_uuid,
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_history_uuid') AS idx_review_history_uuid
`;

const SCHEMA_FLAG_KEYS = [
  "has_user_review_meta",
  "users_srs_algorithm",
  "reviews_stability",
  "reviews_difficulty",
  "reviews_fsrs_state",
  "reviews_lapses",
  "reviews_fsrs_reps",
  "reviews_fsrs_last_review",
  "review_history_algorithm",
  "review_history_snapshot",
  "words_user_id",
  "has_words_table",
  "idx_user_review_state_mode",
  "idx_user_review_meta_user",
  "idx_sessions_expires",
  "idx_words_word",
  "idx_reviews_next_review",
  "idx_review_history_word",
  "idx_review_history_reviewed",
  "idx_words_user",
  "words_uuid",
  "words_deleted_at",
  "review_history_uuid",
  "idx_words_uuid",
  "idx_review_history_uuid",
] as const;

type SchemaFlags = Partial<Record<(typeof SCHEMA_FLAG_KEYS)[number], number>>;

async function inspectSchemaFlags(db: DatabaseAdapter): Promise<SchemaFlags> {
  const row = await db.prepare(SCHEMA_INSPECT_SQL).get();
  if (!row) throw new Error("Schema inspection returned no rows");
  return row as SchemaFlags;
}

function flag(flags: SchemaFlags, key: string): boolean {
  return Number(flags[key as keyof SchemaFlags] ?? 0) > 0;
}

function schemaIsCurrent(flags: SchemaFlags): boolean {
  return SCHEMA_FLAG_KEYS.every((key) => flag(flags, key));
}

const CREATE_TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  `CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  `CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      word TEXT NOT NULL,
      translation TEXT NOT NULL,
      definitions TEXT,
      examples TEXT,
      phonetic TEXT,
      audio_url TEXT,
      source_language TEXT DEFAULT 'en',
      target_language TEXT DEFAULT 'zh-CN',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, word)
    )`,
  `CREATE TABLE IF NOT EXISTS reviews (
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
    )`,
  `CREATE TABLE IF NOT EXISTS review_history (
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
    )`,
  `CREATE TABLE IF NOT EXISTS user_review_state (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('review','new')),
      word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, device_id, mode, word_id)
    )`,
  `CREATE TABLE IF NOT EXISTS user_review_meta (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('review','new')),
      current_index INTEGER NOT NULL DEFAULT 0,
      reviewed_count INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, device_id, mode)
    )`,
];

const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_user_review_state_mode ON user_review_state(user_id, mode)`,
  `CREATE INDEX IF NOT EXISTS idx_user_review_meta_user ON user_review_meta(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_words_word ON words(word)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_next_review ON reviews(next_review_date)`,
  `CREATE INDEX IF NOT EXISTS idx_review_history_word ON review_history(word_id)`,
  `CREATE INDEX IF NOT EXISTS idx_review_history_reviewed ON review_history(reviewed_at DESC, id DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_words_uuid ON words(uuid)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_review_history_uuid ON review_history(uuid)`,
];

/**
 * Builds the DDL needed to converge on the current schema, adding an ALTER
 * only for columns/objects the inspect query reported as missing.
 */
function buildDdlStatements(flags: SchemaFlags): string[] {
  const statements = [...CREATE_TABLE_STATEMENTS];

  if (!flag(flags, "users_srs_algorithm")) {
    statements.push(
      `ALTER TABLE users ADD COLUMN srs_algorithm TEXT NOT NULL DEFAULT 'sm2'`
    );
  }
  if (!flag(flags, "reviews_stability")) {
    statements.push(`ALTER TABLE reviews ADD COLUMN stability REAL`);
  }
  if (!flag(flags, "reviews_difficulty")) {
    statements.push(`ALTER TABLE reviews ADD COLUMN difficulty REAL`);
  }
  if (!flag(flags, "reviews_fsrs_state")) {
    statements.push(`ALTER TABLE reviews ADD COLUMN fsrs_state INTEGER`);
  }
  if (!flag(flags, "reviews_lapses")) {
    statements.push(`ALTER TABLE reviews ADD COLUMN lapses INTEGER`);
  }
  if (!flag(flags, "reviews_fsrs_reps")) {
    statements.push(`ALTER TABLE reviews ADD COLUMN fsrs_reps INTEGER`);
  }
  if (!flag(flags, "reviews_fsrs_last_review")) {
    statements.push(`ALTER TABLE reviews ADD COLUMN fsrs_last_review DATETIME`);
  }
  if (!flag(flags, "review_history_algorithm")) {
    statements.push(
      `ALTER TABLE review_history ADD COLUMN algorithm TEXT NOT NULL DEFAULT 'sm2'`
    );
  }
  if (!flag(flags, "review_history_snapshot")) {
    statements.push(`ALTER TABLE review_history ADD COLUMN snapshot TEXT`);
  }
  if (!flag(flags, "words_uuid")) {
    statements.push(`ALTER TABLE words ADD COLUMN uuid TEXT`);
  }
  if (!flag(flags, "words_deleted_at")) {
    statements.push(`ALTER TABLE words ADD COLUMN deleted_at DATETIME`);
  }
  if (!flag(flags, "review_history_uuid")) {
    statements.push(`ALTER TABLE review_history ADD COLUMN uuid TEXT`);
  }

  statements.push(...INDEX_STATEMENTS);

  // A database that has not run `migrate:multiuser` yet still has the old
  // `words` table without `user_id`. Skip the index in that case (the migration
  // script creates it when it rebuilds the table). On a fresh database the
  // words table is created by this batch WITH user_id, so the index applies.
  const wordsWillHaveUserId =
    flag(flags, "words_user_id") || !flag(flags, "has_words_table");
  if (wordsWillHaveUserId) {
    statements.push(`CREATE INDEX IF NOT EXISTS idx_words_user ON words(user_id)`);
  }

  return statements;
}

/**
 * Fallback used only when the single-query inspection itself fails (e.g. an
 * unexpected backend limitation): run the idempotent base DDL as one batch,
 * then attempt each column migration individually so a duplicate-column error
 * on an already-migrated database does not break the run.
 */
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "users", column: "srs_algorithm", ddl: `ALTER TABLE users ADD COLUMN srs_algorithm TEXT NOT NULL DEFAULT 'sm2'` },
  { table: "reviews", column: "stability", ddl: `ALTER TABLE reviews ADD COLUMN stability REAL` },
  { table: "reviews", column: "difficulty", ddl: `ALTER TABLE reviews ADD COLUMN difficulty REAL` },
  { table: "reviews", column: "fsrs_state", ddl: `ALTER TABLE reviews ADD COLUMN fsrs_state INTEGER` },
  { table: "reviews", column: "lapses", ddl: `ALTER TABLE reviews ADD COLUMN lapses INTEGER` },
  { table: "reviews", column: "fsrs_reps", ddl: `ALTER TABLE reviews ADD COLUMN fsrs_reps INTEGER` },
  { table: "reviews", column: "fsrs_last_review", ddl: `ALTER TABLE reviews ADD COLUMN fsrs_last_review DATETIME` },
  { table: "review_history", column: "algorithm", ddl: `ALTER TABLE review_history ADD COLUMN algorithm TEXT NOT NULL DEFAULT 'sm2'` },
  { table: "review_history", column: "snapshot", ddl: `ALTER TABLE review_history ADD COLUMN snapshot TEXT` },
  { table: "words", column: "uuid", ddl: `ALTER TABLE words ADD COLUMN uuid TEXT` },
  { table: "words", column: "deleted_at", ddl: `ALTER TABLE words ADD COLUMN deleted_at DATETIME` },
  { table: "review_history", column: "uuid", ddl: `ALTER TABLE review_history ADD COLUMN uuid TEXT` },
];

async function migrateColumnsBestEffort(db: DatabaseAdapter): Promise<void> {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    try {
      const rows = await db
        .prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('${table}') WHERE name = ?`)
        .all(column);
      if (Number(rows[0]?.count ?? 0) > 0) continue;
      await db.exec(ddl);
    } catch (error) {
      console.error(`Column migration failed for ${table}.${column}:`, error);
    }
  }

  try {
    const rows = await db
      .prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('words') WHERE name = ?`)
      .all("user_id");
    if (Number(rows[0]?.count ?? 0) > 0) {
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_words_user ON words(user_id)`);
    }
  } catch (error) {
    console.error("idx_words_user migration failed:", error);
  }
}

/**
 * Converges the database schema on the given adapter. This is an explicit
 * operation: run it via `bun run migrate` (scripts/migrate.ts). It is NOT
 * called in the Turso request path, so a serverless cold start never pays
 * round trips for schema checks.
 *
 * - Schema current: 1 inspect query, no DDL.
 * - Schema behind:  1 inspect query + 1 atomic batch with only the missing DDL.
 */
export async function ensureSchema(
  db: DatabaseAdapter
): Promise<SchemaMigrationReport> {
  let flags: SchemaFlags | null = null;
  try {
    flags = await inspectSchemaFlags(db);
  } catch (error) {
    console.error("Schema inspection failed; falling back to base DDL:", error);
  }
  if (flags && schemaIsCurrent(flags)) {
    return { changed: false, statements: 0 };
  }

  if (flags) {
    const statements = buildDdlStatements(flags);
    // A single batch is one round trip on Turso (and atomic); on local SQLite
    // it runs inside a transaction.
    await db.batch(statements);
    return { changed: true, statements: statements.length };
  }

  await db.batch([...CREATE_TABLE_STATEMENTS, ...INDEX_STATEMENTS]);
  await migrateColumnsBestEffort(db);
  return { changed: true, statements: -1 };
}
