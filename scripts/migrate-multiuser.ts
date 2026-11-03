import { db, initDatabase } from "../lib/db/init.ts";

const REBUILD_STATEMENTS = [
  `DROP TABLE IF EXISTS review_history_migrated`,
  `DROP TABLE IF EXISTS reviews_migrated`,
  `DROP TABLE IF EXISTS words_migrated`,
  `DROP TABLE IF EXISTS user_review_state_migrated`,
  `DROP TABLE IF EXISTS user_review_meta_migrated`,

  `CREATE TABLE words_migrated (
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

  `INSERT INTO words_migrated
    (id, word, translation, definitions, examples, phonetic, audio_url,
     source_language, target_language, created_at, updated_at)
   SELECT id, word, translation, definitions, examples, phonetic, audio_url,
          source_language, target_language, created_at, updated_at
   FROM words`,

  `CREATE TABLE reviews_migrated (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL REFERENCES words_migrated(id) ON DELETE CASCADE,
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval INTEGER NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    next_review_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_reviewed DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(word_id)
  )`,

  `INSERT INTO reviews_migrated
    (id, word_id, ease_factor, interval, repetitions, next_review_date,
     last_reviewed, created_at, updated_at)
   SELECT id, word_id, ease_factor, interval, repetitions, next_review_date,
          last_reviewed, created_at, updated_at
   FROM reviews`,

  `CREATE TABLE review_history_migrated (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL REFERENCES words_migrated(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL,
    previous_ease_factor REAL NOT NULL,
    previous_interval INTEGER NOT NULL,
    previous_repetitions INTEGER NOT NULL,
    new_ease_factor REAL NOT NULL,
    new_interval INTEGER NOT NULL,
    new_repetitions INTEGER NOT NULL,
    reviewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `INSERT INTO review_history_migrated
    (id, word_id, rating, previous_ease_factor, previous_interval,
     previous_repetitions, new_ease_factor, new_interval, new_repetitions,
     reviewed_at)
   SELECT id, word_id, rating, previous_ease_factor, previous_interval,
          previous_repetitions, new_ease_factor, new_interval, new_repetitions,
          reviewed_at
   FROM review_history`,


  `CREATE TABLE user_review_state_migrated (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('review','new')),
    word_id INTEGER NOT NULL REFERENCES words_migrated(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id, mode, word_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_user_review_state_user ON user_review_state_migrated(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_review_state_mode ON user_review_state_migrated(user_id, mode)`,

  `CREATE TABLE user_review_meta_migrated (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('review','new')),
    current_index INTEGER NOT NULL DEFAULT 0,
    reviewed_count INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id, mode)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_user_review_meta_user ON user_review_meta_migrated(user_id)`,
  `DROP TABLE review_history`,
  `DROP TABLE reviews`,
  `DROP TABLE words`,

  `ALTER TABLE words_migrated RENAME TO words`,
  `ALTER TABLE reviews_migrated RENAME TO reviews`,
  `ALTER TABLE review_history_migrated RENAME TO review_history`,
  `ALTER TABLE user_review_meta_migrated RENAME TO user_review_meta`,
  `ALTER TABLE user_review_state_migrated RENAME TO user_review_state`,

  `CREATE INDEX IF NOT EXISTS idx_words_word ON words(word)`,
  `CREATE INDEX IF NOT EXISTS idx_words_user ON words(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_next_review ON reviews(next_review_date)`,
  `CREATE INDEX IF NOT EXISTS idx_review_history_word ON review_history(word_id)`,
];

async function wordsHasColumn(column: string): Promise<boolean> {
  const rows = await db.prepare("PRAGMA table_info(words)").all();
  return rows.some((row) => String(row.name) === column);
}

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.count ?? 0);
}

function describeTarget(): string {
  if ((process.env.DB_MODE || "local") === "turso") {
    return `turso ${process.env.TURSO_URL || "(default url)"}`;
  }
  return `local ${process.env.DB_PATH || "./data/vocleap.db"}`;
}

async function assertNoOrphans(stage: string): Promise<void> {
  const rows = await db.prepare("PRAGMA foreign_key_check").all();
  if (rows.length === 0) return;

  const sample = rows
    .slice(0, 5)
    .map((row) => `${row.table}#${row.rowid} → ${row.parent}`)
    .join(", ");
  throw new Error(
    `${stage}: ${rows.length} orphaned row(s) break foreign keys (${sample}). ` +
      `Repair them before migrating.`
  );
}

async function main() {
  console.log(`Target: ${describeTarget()}`);

  await initDatabase();

  if (await wordsHasColumn("user_id")) {
    console.log("words.user_id already exists — nothing to do.");
    return;
  }

  const beforeWords = await count("words");
  const beforeReviews = await count("reviews");
  const beforeHistory = await count("review_history");

  await assertNoOrphans("Before migration");

  console.log(
    `Migrating ${beforeWords} words, ${beforeReviews} reviews, ${beforeHistory} history rows...`
  );

  await db.batch(REBUILD_STATEMENTS);

  const afterWords = await count("words");
  const afterReviews = await count("reviews");
  const afterHistory = await count("review_history");

  if (
    afterWords !== beforeWords ||
    afterReviews !== beforeReviews ||
    afterHistory !== beforeHistory
  ) {
    throw new Error(
      `Row count mismatch after migration: words ${beforeWords}→${afterWords}, ` +
        `reviews ${beforeReviews}→${afterReviews}, history ${beforeHistory}→${afterHistory}`
    );
  }

  await assertNoOrphans("After migration");

  const columns = await db.prepare("PRAGMA table_info(words)").all();
  console.log(
    `words columns: ${columns.map((row) => String(row.name)).join(", ")}`
  );
  console.log(
    `Migration complete: words ${afterWords}, reviews ${afterReviews}, history ${afterHistory}.`
  );
}

main()
  .then(async () => {
    await db.close();
  })
  .catch(async (error) => {
    console.error("Migration failed:", error);
    process.exitCode = 1;
    await db.close().catch(() => {});
  });
