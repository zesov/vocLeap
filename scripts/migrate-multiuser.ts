import { db, initDatabase } from "../lib/db/init.ts";

const REBUILD_STATEMENTS = [
  `DROP TABLE IF EXISTS review_history_migrated`,
  `DROP TABLE IF EXISTS reviews_migrated`,
  `DROP TABLE IF EXISTS words_migrated`,

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

  `DROP TABLE review_history`,
  `DROP TABLE reviews`,
  `DROP TABLE words`,

  `ALTER TABLE words_migrated RENAME TO words`,
  `ALTER TABLE reviews_migrated RENAME TO reviews`,
  `ALTER TABLE review_history_migrated RENAME TO review_history`,

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

async function main() {
  await initDatabase();

  if (await wordsHasColumn("user_id")) {
    console.log("words.user_id already exists — nothing to do.");
    return;
  }

  const beforeWords = await count("words");
  const beforeReviews = await count("reviews");
  const beforeHistory = await count("review_history");

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

  console.log(
    `Migration complete: words ${afterWords}, reviews ${afterReviews}, history ${afterHistory}.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
