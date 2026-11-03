import { db } from "./init";

export interface Word {
  id?: number;
  word: string;
  translation: string;
  definitions: string[];
  examples: string[];
  phonetic?: string;
  audioUrl?: string;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Review {
  id?: number;
  wordId: number;
  easeFactor: number;
  interval: number;
  repetitions: number;
  nextReviewDate: string;
  lastReviewed?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReviewHistory {
  id?: number;
  wordId: number;
  rating: number;
  previousEaseFactor: number;
  previousInterval: number;
  previousRepetitions: number;
  newEaseFactor: number;
  newInterval: number;
  newRepetitions: number;
  reviewedAt?: string;
}

export interface ReviewSession {
  id?: number;
  userId: number;
  deviceId: string;
  queueType: "due" | "new";
  queueWordIds: number[];
  currentIndex: number;
  stats: {
    reviewed: number;
    again: number;
    hard: number;
    good: number;
    easy: number;
  };
  updatedAt?: string;
}

// Row shapes as they come back from the database (snake_case columns).
interface ReviewRow {
  id: number;
  word_id: number;
  ease_factor: number;
  interval: number;
  repetitions: number;
  next_review_date: string;
  last_reviewed: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ReviewHistoryRow {
  id: number;
  word_id: number;
  rating: number;
  previous_ease_factor: number;
  previous_interval: number;
  previous_repetitions: number;
  new_ease_factor: number;
  new_interval: number;
  new_repetitions: number;
  reviewed_at: string | null;
}

interface ReviewSessionRow {
  id: number;
  user_id: number;
  device_id: string;
  queue_type: "due" | "new";
  queue_word_ids: string;
  current_index: number;
  stats_json: string;
  updated_at: string | null;
}

interface WordColumns {
  word: string;
  translation: string;
  definitions: string | null;
  examples: string | null;
  phonetic: string | null;
  audio_url: string | null;
  source_language: string;
  target_language: string;
}

type WordRow = WordColumns & {
  id: number;
  created_at: string | null;
  updated_at: string | null;
};
type ReviewWithWordRow = ReviewRow & WordColumns;
type NewWordRow = WordColumns & {
  word_id: number;
  created_at: string | null;
  updated_at: string | null;
};
type ReviewHistoryWithWordRow = ReviewHistoryRow &
  Pick<WordColumns, "word" | "translation">;

// The adapter hands rows back as Record<string, unknown>; assert the shape each query selected.
function toRow<T>(row: Record<string, unknown> | null): T | null {
  return row as unknown as T | null;
}

function toRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows as unknown as T[];
}

function wordFromRow(r: WordRow): Word {
  return {
    id: r.id,
    word: r.word,
    translation: r.translation,
    definitions: JSON.parse(String(r.definitions || "[]")),
    examples: JSON.parse(String(r.examples || "[]")),
    phonetic: r.phonetic ?? undefined,
    audioUrl: r.audio_url ?? undefined,
    sourceLanguage: r.source_language,
    targetLanguage: r.target_language,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
  };
}

export async function createWord(
  userId: number,
  word: Omit<Word, "id" | "createdAt" | "updatedAt">
): Promise<number> {
  const stmt = db.prepare(`
    INSERT INTO words (user_id, word, translation, definitions, examples, phonetic, audio_url, source_language, target_language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = await stmt.run(
    userId,
    word.word,
    word.translation,
    JSON.stringify(word.definitions),
    JSON.stringify(word.examples),
    word.phonetic || null,
    word.audioUrl || null,
    word.sourceLanguage,
    word.targetLanguage
  );
  return Number(result.lastInsertRowid);
}

export async function getWordById(
  userId: number,
  id: number
): Promise<Word | null> {
  const stmt = db.prepare("SELECT * FROM words WHERE id = ? AND user_id = ?");
  const r = toRow<WordRow>(await stmt.get(id, userId));
  return r ? wordFromRow(r) : null;
}

export async function getWordByText(
  userId: number,
  word: string
): Promise<Word | null> {
  const stmt = db.prepare("SELECT * FROM words WHERE word = ? AND user_id = ?");
  const r = toRow<WordRow>(await stmt.get(word, userId));
  return r ? wordFromRow(r) : null;
}

export async function getAllWords(
  userId: number,
  limit: number = 50,
  offset: number = 0
): Promise<{ words: Word[]; total: number }> {
  const countStmt = db.prepare("SELECT COUNT(*) as count FROM words WHERE user_id = ?");
  const totalRow = await countStmt.get(userId);
  const total = Number(totalRow?.count ?? 0);

  const stmt = db.prepare(
    "SELECT * FROM words WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
  );
  const rows = toRows<WordRow>(await stmt.all(userId, limit, offset));
  return {
    words: rows.map(wordFromRow),
    total,
  };
}

export async function updateWord(
  userId: number,
  id: number,
  updates: Partial<Word>
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.translation) {
    fields.push("translation = ?");
    values.push(updates.translation);
  }
  if (updates.definitions) {
    fields.push("definitions = ?");
    values.push(JSON.stringify(updates.definitions));
  }
  if (updates.examples) {
    fields.push("examples = ?");
    values.push(JSON.stringify(updates.examples));
  }
  if (updates.phonetic !== undefined) {
    fields.push("phonetic = ?");
    values.push(updates.phonetic);
  }
  if (updates.audioUrl !== undefined) {
    fields.push("audio_url = ?");
    values.push(updates.audioUrl);
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id, userId);

  const stmt = db.prepare(
    `UPDATE words SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`
  );
  const result = await stmt.run(...values);
  return result.changes > 0;
}

export async function deleteWord(
  userId: number,
  id: number
): Promise<boolean> {
  const stmt = db.prepare("DELETE FROM words WHERE id = ? AND user_id = ?");
  const result = await stmt.run(id, userId);
  return result.changes > 0;
}

export async function assertWordOwned(
  userId: number,
  wordId: number
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM words WHERE id = ? AND user_id = ?")
    .get(wordId, userId);
  return row !== null;
}

export async function createOrUpdateReview(
  review: Omit<Review, "id" | "createdAt" | "updatedAt">
): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO reviews (word_id, ease_factor, interval, repetitions, next_review_date, last_reviewed)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(word_id) DO UPDATE SET
      ease_factor = excluded.ease_factor,
      interval = excluded.interval,
      repetitions = excluded.repetitions,
      next_review_date = excluded.next_review_date,
      last_reviewed = excluded.last_reviewed,
      updated_at = CURRENT_TIMESTAMP
  `);
  await stmt.run(
    review.wordId,
    review.easeFactor,
    review.interval,
    review.repetitions,
    review.nextReviewDate,
    review.lastReviewed || null
  );
}

export async function getReview(
  userId: number,
  wordId: number
): Promise<Review | null> {
  const stmt = db.prepare(`
    SELECT r.*
    FROM reviews r
    JOIN words w ON w.id = r.word_id
    WHERE r.word_id = ? AND w.user_id = ?
  `);
  const r = toRow<ReviewRow>(await stmt.get(wordId, userId));
  if (!r) return null;
  return {
    id: r.id,
    wordId: r.word_id,
    easeFactor: r.ease_factor,
    interval: r.interval,
    repetitions: r.repetitions,
    nextReviewDate: r.next_review_date,
    lastReviewed: r.last_reviewed ?? undefined,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
  };
}

export async function getDueReviews(
  userId: number,
  limit: number = 20
): Promise<(Review & { word: Word })[]> {
  const stmt = db.prepare(`
    SELECT r.*, w.word, w.translation, w.definitions, w.examples, w.phonetic, w.audio_url, w.source_language, w.target_language
    FROM reviews r
    JOIN words w ON r.word_id = w.id
    WHERE r.next_review_date <= datetime('now') AND w.user_id = ?
    ORDER BY r.next_review_date ASC
    LIMIT ?
  `);
  const rows = toRows<ReviewWithWordRow>(await stmt.all(userId, limit));
  return rows.map((r) => ({
    id: r.id,
    wordId: r.word_id,
    easeFactor: r.ease_factor,
    interval: r.interval,
    repetitions: r.repetitions,
    nextReviewDate: r.next_review_date,
    lastReviewed: r.last_reviewed ?? undefined,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
    word: {
      id: r.word_id,
      word: r.word,
      translation: r.translation,
      definitions: JSON.parse(String(r.definitions || "[]")),
      examples: JSON.parse(String(r.examples || "[]")),
      phonetic: r.phonetic ?? undefined,
      audioUrl: r.audio_url ?? undefined,
      sourceLanguage: r.source_language,
      targetLanguage: r.target_language,
    },
  }));
}

export async function getAllReviewsForUser(
  userId: number,
  limit: number = 200
): Promise<(Review & { word: Word })[]> {
  const stmt = db.prepare(`
    SELECT r.*, w.word, w.translation, w.definitions, w.examples, w.phonetic, w.audio_url, w.source_language, w.target_language
    FROM reviews r
    JOIN words w ON r.word_id = w.id
    WHERE w.user_id = ?
    ORDER BY r.next_review_date ASC
    LIMIT ?
  `);
  const rows = toRows<ReviewWithWordRow>(await stmt.all(userId, limit));
  return rows.map((r) => ({
    id: r.id,
    wordId: r.word_id,
    easeFactor: r.ease_factor,
    interval: r.interval,
    repetitions: r.repetitions,
    nextReviewDate: r.next_review_date,
    lastReviewed: r.last_reviewed ?? undefined,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
    word: {
      id: r.word_id,
      word: r.word,
      translation: r.translation,
      definitions: JSON.parse(String(r.definitions || "[]")),
      examples: JSON.parse(String(r.examples || "[]")),
      phonetic: r.phonetic ?? undefined,
      audioUrl: r.audio_url ?? undefined,
      sourceLanguage: r.source_language,
      targetLanguage: r.target_language,
    },
  }));
}

export async function getNewWords(
  userId: number,
  limit: number = 20
): Promise<Array<Review & { word: Word }>> {
  const stmt = db.prepare(`
    SELECT w.id as word_id, w.word, w.translation, w.definitions, w.examples, w.phonetic, w.audio_url, w.source_language, w.target_language, w.created_at, w.updated_at
    FROM words w
    LEFT JOIN reviews r ON w.id = r.word_id
    WHERE r.word_id IS NULL AND w.user_id = ?
    ORDER BY w.created_at DESC
    LIMIT ?
  `);
  const rows = toRows<NewWordRow>(await stmt.all(userId, limit));
  return rows.map((r) => ({
    id: r.word_id,
    wordId: r.word_id,
    easeFactor: 2.5,
    interval: 0,
    repetitions: 0,
    nextReviewDate: new Date().toISOString(),
    lastReviewed: undefined,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
    word: {
      id: r.word_id,
      word: r.word,
      translation: r.translation,
      definitions: JSON.parse(String(r.definitions || "[]")),
      examples: JSON.parse(String(r.examples || "[]")),
      phonetic: r.phonetic ?? undefined,
      audioUrl: r.audio_url ?? undefined,
      sourceLanguage: r.source_language,
      targetLanguage: r.target_language,
    },
  }));
}

export async function getReviewStats(userId: number): Promise<{
  due: number;
  total: number;
  newWords: number;
}> {
  const dueStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM reviews r
    JOIN words w ON w.id = r.word_id
    WHERE w.user_id = ? AND r.next_review_date <= datetime('now')
  `);
  const totalStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM reviews r
    JOIN words w ON w.id = r.word_id
    WHERE w.user_id = ?
  `);
  const newStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM words w
    LEFT JOIN reviews r ON w.id = r.word_id
    WHERE w.user_id = ? AND r.word_id IS NULL
  `);

  const dueRow = await dueStmt.get(userId);
  const totalRow = await totalStmt.get(userId);
  const newRow = await newStmt.get(userId);

  return {
    due: Number(dueRow?.count ?? 0),
    total: Number(totalRow?.count ?? 0),
    newWords: Number(newRow?.count ?? 0),
  };
}

export async function addReviewHistory(
  history: Omit<ReviewHistory, "id" | "reviewedAt">
): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO review_history (word_id, rating, previous_ease_factor, previous_interval, previous_repetitions, new_ease_factor, new_interval, new_repetitions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await stmt.run(
    history.wordId,
    history.rating,
    history.previousEaseFactor,
    history.previousInterval,
    history.previousRepetitions,
    history.newEaseFactor,
    history.newInterval,
    history.newRepetitions
  );
}

export async function getReviewHistory(
  userId: number,
  wordId: number
): Promise<ReviewHistory[]> {
  const stmt = db.prepare(`
    SELECT rh.*
    FROM review_history rh
    JOIN words w ON w.id = rh.word_id
    WHERE rh.word_id = ? AND w.user_id = ?
    ORDER BY rh.reviewed_at DESC
  `);
  const rows = toRows<ReviewHistoryRow>(await stmt.all(wordId, userId));
  return rows.map((r) => ({
    id: r.id,
    wordId: r.word_id,
    rating: r.rating,
    previousEaseFactor: r.previous_ease_factor,
    previousInterval: r.previous_interval,
    previousRepetitions: r.previous_repetitions,
    newEaseFactor: r.new_ease_factor,
    newInterval: r.new_interval,
    newRepetitions: r.new_repetitions,
    reviewedAt: r.reviewed_at ?? undefined,
  }));
}

export async function getAllReviewHistory(
  userId: number
): Promise<Array<ReviewHistory & { word: string; translation: string }>> {
  const stmt = db.prepare(`
    SELECT rh.*, w.word, w.translation
    FROM review_history rh
    JOIN words w ON rh.word_id = w.id
    WHERE w.user_id = ?
    ORDER BY rh.reviewed_at DESC
  `);
  const rows = toRows<ReviewHistoryWithWordRow>(await stmt.all(userId));
  return rows.map((r) => ({
    id: r.id,
    wordId: r.word_id,
    rating: r.rating,
    previousEaseFactor: r.previous_ease_factor,
    previousInterval: r.previous_interval,
    previousRepetitions: r.previous_repetitions,
    newEaseFactor: r.new_ease_factor,
    newInterval: r.new_interval,
    newRepetitions: r.new_repetitions,
    reviewedAt: r.reviewed_at ?? undefined,
    word: r.word,
    translation: r.translation,
  }));
}

export async function getReviewSession(
  userId: number,
  deviceId: string,
  queueType: "due" | "new"
): Promise<ReviewSession | null> {
  const stmt = db.prepare(`
    SELECT * FROM review_sessions
    WHERE user_id = ? AND device_id = ? AND queue_type = ?
  `);
  const row = toRow<ReviewSessionRow>(await stmt.get(userId, deviceId, queueType));
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    queueType: row.queue_type,
    queueWordIds: JSON.parse(row.queue_word_ids),
    currentIndex: row.current_index,
    stats: JSON.parse(row.stats_json),
    updatedAt: row.updated_at ?? undefined,
  };
}

export async function getLatestReviewSession(
  userId: number,
  queueType: "due" | "new"
): Promise<ReviewSession | null> {
  const stmt = db.prepare(`
    SELECT * FROM review_sessions
    WHERE user_id = ? AND queue_type = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const row = toRow<ReviewSessionRow>(await stmt.get(userId, queueType));
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    queueType: row.queue_type,
    queueWordIds: JSON.parse(row.queue_word_ids),
    currentIndex: row.current_index,
    stats: JSON.parse(row.stats_json),
    updatedAt: row.updated_at ?? undefined,
  };
}

export async function upsertReviewSession(
  session: Omit<ReviewSession, "id" | "updatedAt">
): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO review_sessions (user_id, device_id, queue_type, queue_word_ids, current_index, stats_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, queue_type) DO UPDATE SET
      queue_word_ids = excluded.queue_word_ids,
      current_index = excluded.current_index,
      stats_json = excluded.stats_json,
      updated_at = CURRENT_TIMESTAMP
  `);
  await stmt.run(
    session.userId,
    session.deviceId,
    session.queueType,
    JSON.stringify(session.queueWordIds),
    session.currentIndex,
    JSON.stringify(session.stats)
  );
}

// New per-word position tracking for cross-device sync
export interface UserReviewState {
  userId: number;
  mode: "review" | "new";
  wordId: number;
  position: number;
  updatedAt: string;
}

interface UserReviewStateRow {
  user_id: number;
  mode: "review" | "new";
  word_id: number;
  position: number;
  updated_at: string;
}

export async function getUserReviewState(
  userId: number,
  mode: "review" | "new"
): Promise<UserReviewState[]> {
  const stmt = db.prepare(`
    SELECT * FROM user_review_state
    WHERE user_id = ? AND mode = ?
    ORDER BY position ASC
  `);
  const rows = toRows<UserReviewStateRow>(await stmt.all(userId, mode));
  return rows.map((r) => ({
    userId: r.user_id,
    mode: r.mode,
    wordId: r.word_id,
    position: r.position,
    updatedAt: r.updated_at,
  }));
}

export async function upsertUserReviewState(
  state: UserReviewState
): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO user_review_state (user_id, mode, word_id, position, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, mode, word_id) DO UPDATE SET
      position = excluded.position,
      updated_at = excluded.updated_at
  `);
  await stmt.run(state.userId, state.mode, state.wordId, state.position, state.updatedAt);
}

export async function upsertUserReviewStates(
  states: UserReviewState[]
): Promise<void> {
  if (states.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO user_review_state (user_id, mode, word_id, position, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, mode, word_id) DO UPDATE SET
      position = excluded.position,
      updated_at = excluded.updated_at
  `);
  for (const state of states) {
    await stmt.run(state.userId, state.mode, state.wordId, state.position, state.updatedAt);
  }
}

export async function clearUserReviewState(
  userId: number,
  mode: "review" | "new"
): Promise<void> {
  const stmt = db.prepare(`
    DELETE FROM user_review_state WHERE user_id = ? AND mode = ?
  `);
  await stmt.run(userId, mode);
}

export async function getUserReviewMeta(
  userId: number,
  mode: "review" | "new"
): Promise<{ currentIndex: number; reviewedCount: number; updatedAt: string } | null> {
  const stmt = db.prepare(`
    SELECT current_index, reviewed_count, updated_at FROM user_review_meta
    WHERE user_id = ? AND mode = ?
  `);
  const row = toRow<{ current_index: number; reviewed_count: number; updated_at: string }>(await stmt.get(userId, mode));
  if (!row) return null;
  return { currentIndex: row.current_index, reviewedCount: row.reviewed_count, updatedAt: row.updated_at };
}

export async function upsertUserReviewMeta(
  userId: number,
  mode: "review" | "new",
  currentIndex: number,
  reviewedCount: number
): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO user_review_meta (user_id, mode, current_index, reviewed_count, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, mode) DO UPDATE SET
      current_index = excluded.current_index,
      reviewed_count = excluded.reviewed_count,
      updated_at = excluded.updated_at
  `);
  await stmt.run(userId, mode, currentIndex, reviewedCount, new Date().toISOString());
}
