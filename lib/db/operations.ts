import { db } from "./init";
import {
  fsrsStateFromColumns,
  type FsrsState,
  type ReviewStateSnapshot,
} from "@/lib/srs/fsrs";
import { uuidv7 } from "@/lib/uuid";

export type SrsAlgorithm = "sm2" | "fsrs";

export type ReviewSnapshot = {
  before: ReviewStateSnapshot;
  after: ReviewStateSnapshot;
};

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
  uuid?: string;
  deletedAt?: string;
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
  fsrsState?: FsrsState;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReviewHistory {
  id?: number;
  uuid?: string;
  wordId: number;
  rating: number;
  previousEaseFactor: number;
  previousInterval: number;
  previousRepetitions: number;
  newEaseFactor: number;
  newInterval: number;
  newRepetitions: number;
  algorithm: SrsAlgorithm;
  snapshot?: ReviewSnapshot;
  reviewedAt?: string;
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
  stability: number | null;
  difficulty: number | null;
  fsrs_state: number | null;
  lapses: number | null;
  fsrs_reps: number | null;
  fsrs_last_review: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ReviewHistoryRow {
  id: number;
  uuid: string | null;
  word_id: number;
  rating: number;
  previous_ease_factor: number;
  previous_interval: number;
  previous_repetitions: number;
  new_ease_factor: number;
  new_interval: number;
  new_repetitions: number;
  algorithm: string | null;
  snapshot: string | null;
  reviewed_at: string | null;
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
  uuid: string | null;
  deleted_at: string | null;
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

function fsrsStateFromReviewRow(r: ReviewRow): FsrsState | undefined {
  return (
    fsrsStateFromColumns({
      stability: r.stability,
      difficulty: r.difficulty,
      fsrs_state: r.fsrs_state,
      lapses: r.lapses,
      reps: r.fsrs_reps,
      fsrs_due: r.next_review_date,
      fsrs_last_review: r.fsrs_last_review,
    }) ?? undefined
  );
}

function parseHistorySnapshot(raw: string | null): ReviewSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ReviewSnapshot;
    return parsed.before && parsed.after ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    uuid: r.uuid ?? undefined,
    deletedAt: r.deleted_at ?? undefined,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
  };
}

export async function createWord(
  userId: number,
  word: Omit<Word, "id" | "createdAt" | "updatedAt">
): Promise<number> {
  const stmt = db.prepare(`
    INSERT INTO words (user_id, uuid, word, translation, definitions, examples, phonetic, audio_url, source_language, target_language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = await stmt.run(
    userId,
    uuidv7(),
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
  const stmt = db.prepare("SELECT * FROM words WHERE id = ? AND user_id = ? AND deleted_at IS NULL");
  const r = toRow<WordRow>(await stmt.get(id, userId));
  return r ? wordFromRow(r) : null;
}

export async function getWordByText(
  userId: number,
  word: string
): Promise<Word | null> {
  const stmt = db.prepare("SELECT * FROM words WHERE word = ? AND user_id = ? AND deleted_at IS NULL");
  const r = toRow<WordRow>(await stmt.get(word, userId));
  return r ? wordFromRow(r) : null;
}

export type WordSort = "date_desc" | "date_asc" | "alpha_asc" | "alpha_desc";

const WORD_SORT_CLAUSES: Record<WordSort, string> = {
  date_desc: "updated_at DESC, id DESC",
  date_asc: "updated_at ASC, id ASC",
  alpha_asc: "word COLLATE NOCASE ASC, id ASC",
  alpha_desc: "word COLLATE NOCASE DESC, id DESC",
};

export function isWordSort(value: unknown): value is WordSort {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(WORD_SORT_CLAUSES, value)
  );
}

export async function getAllWords(
  userId: number,
  limit: number = 50,
  offset: number = 0,
  sort: WordSort = "date_desc"
): Promise<{ words: Word[]; total: number }> {
  const countStmt = db.prepare(
    "SELECT COUNT(*) as count FROM words WHERE user_id = ? AND deleted_at IS NULL"
  );
  const totalRow = await countStmt.get(userId);
  const total = Number(totalRow?.count ?? 0);

  const orderBy = isWordSort(sort)
    ? WORD_SORT_CLAUSES[sort]
    : WORD_SORT_CLAUSES.date_desc;
  const stmt = db.prepare(
    `SELECT * FROM words WHERE user_id = ? AND deleted_at IS NULL ORDER BY ${orderBy} LIMIT ? OFFSET ?`
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
  if (updates.sourceLanguage) {
    fields.push("source_language = ?");
    values.push(updates.sourceLanguage);
  }
  if (updates.targetLanguage) {
    fields.push("target_language = ?");
    values.push(updates.targetLanguage);
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
  const stmt = db.prepare(`
    UPDATE words
    SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `);
  const result = await stmt.run(id, userId);
  return result.changes > 0;
}

export async function assertWordOwned(
  userId: number,
  wordId: number
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM words WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .get(wordId, userId);
  return row !== null;
}

export async function createOrUpdateReview(
  review: Omit<Review, "id" | "createdAt" | "updatedAt"> & {
    fsrs?: {
      stability: number;
      difficulty: number;
      state: number;
      lapses: number;
      reps: number;
      lastReview: string | null;
    };
  }
): Promise<void> {
  if (review.fsrs) {
    // SM-2 columns (ease_factor/interval/repetitions) are intentionally frozen
    // here so switching back to SM-2 resumes from that algorithm's own state.
    const stmt = db.prepare(`
      INSERT INTO reviews (word_id, ease_factor, interval, repetitions, next_review_date, last_reviewed, stability, difficulty, fsrs_state, lapses, fsrs_reps, fsrs_last_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(word_id) DO UPDATE SET
        next_review_date = excluded.next_review_date,
        last_reviewed = excluded.last_reviewed,
        stability = excluded.stability,
        difficulty = excluded.difficulty,
        fsrs_state = excluded.fsrs_state,
        lapses = excluded.lapses,
        fsrs_reps = excluded.fsrs_reps,
        fsrs_last_review = excluded.fsrs_last_review,
        updated_at = CURRENT_TIMESTAMP
    `);
    await stmt.run(
      review.wordId,
      review.easeFactor,
      review.interval,
      review.repetitions,
      review.nextReviewDate,
      review.lastReviewed || null,
      review.fsrs.stability,
      review.fsrs.difficulty,
      review.fsrs.state,
      review.fsrs.lapses,
      review.fsrs.reps,
      review.fsrs.lastReview
    );
    return;
  }

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
    WHERE r.word_id = ? AND w.user_id = ? AND w.deleted_at IS NULL
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
    fsrsState: fsrsStateFromReviewRow(r),
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
    WHERE r.next_review_date <= datetime('now') AND w.user_id = ? AND w.deleted_at IS NULL
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
    fsrsState: fsrsStateFromReviewRow(r),
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
    WHERE r.word_id IS NULL AND w.user_id = ? AND w.deleted_at IS NULL
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
  // Single round trip: on a remote backend (Turso) every statement is an HTTP
  // request, so the three counts are computed as subqueries in one statement.
  const stmt = db.prepare(`
    SELECT
      (
        SELECT COUNT(*) FROM reviews r
        JOIN words w ON w.id = r.word_id
        WHERE w.user_id = ? AND w.deleted_at IS NULL
          AND r.next_review_date <= datetime('now')
      ) AS due,
      (
        SELECT COUNT(*) FROM words w
        WHERE w.user_id = ? AND w.deleted_at IS NULL
      ) AS total,
      (
        SELECT COUNT(*) FROM words w
        LEFT JOIN reviews r ON w.id = r.word_id
        WHERE w.user_id = ? AND w.deleted_at IS NULL AND r.word_id IS NULL
      ) AS new_words
  `);
  const row = await stmt.get(userId, userId, userId);

  return {
    due: Number(row?.due ?? 0),
    total: Number(row?.total ?? 0),
    newWords: Number(row?.new_words ?? 0),
  };
}

export async function addReviewHistory(
  history: Omit<ReviewHistory, "id" | "reviewedAt"> & {
    snapshot?: ReviewSnapshot;
  }
): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO review_history (uuid, word_id, rating, previous_ease_factor, previous_interval, previous_repetitions, new_ease_factor, new_interval, new_repetitions, algorithm, snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await stmt.run(
    uuidv7(),
    history.wordId,
    history.rating,
    history.previousEaseFactor,
    history.previousInterval,
    history.previousRepetitions,
    history.newEaseFactor,
    history.newInterval,
    history.newRepetitions,
    history.algorithm,
    history.snapshot ? JSON.stringify(history.snapshot) : null
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
    WHERE rh.word_id = ? AND w.user_id = ? AND w.deleted_at IS NULL
    ORDER BY rh.reviewed_at DESC
  `);
  const rows = toRows<ReviewHistoryRow>(await stmt.all(wordId, userId));
  return rows.map((r) => ({
    id: r.id,
    uuid: r.uuid ?? undefined,
    wordId: r.word_id,
    rating: r.rating,
    previousEaseFactor: r.previous_ease_factor,
    previousInterval: r.previous_interval,
    previousRepetitions: r.previous_repetitions,
    newEaseFactor: r.new_ease_factor,
    newInterval: r.new_interval,
    newRepetitions: r.new_repetitions,
    algorithm: r.algorithm === "fsrs" ? "fsrs" : "sm2",
    snapshot: parseHistorySnapshot(r.snapshot),
    reviewedAt: r.reviewed_at ?? undefined,
  }));
}

export interface ReviewHistoryPage {
  entries: Array<ReviewHistory & { word: string; translation: string }>;
  total: number;
}

/**
 * Offset-paginated review history, newest first.
 *
 * Same shape as `getAllWords()` so the API and the list page can use the same
 * `limit`/`offset`/`hasMore` contract. `id` is the tie-breaker because several
 * reviews can share the same `reviewed_at` second.
 */
export async function getReviewHistoryPage(
  userId: number,
  limit: number = 30,
  offset: number = 0
): Promise<ReviewHistoryPage> {
  const countStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM review_history rh
    JOIN words w ON rh.word_id = w.id
    WHERE w.user_id = ? AND w.deleted_at IS NULL
  `);
  const totalRow = await countStmt.get(userId);
  const total = Number(totalRow?.count ?? 0);

  const stmt = db.prepare(`
    SELECT rh.*, w.word, w.translation
    FROM review_history rh
    JOIN words w ON rh.word_id = w.id
    WHERE w.user_id = ? AND w.deleted_at IS NULL
    ORDER BY rh.reviewed_at DESC, rh.id DESC
    LIMIT ? OFFSET ?
  `);
  const rows = toRows<ReviewHistoryWithWordRow>(
    await stmt.all(userId, limit, offset)
  );

  return {
    total,
    entries: rows.map((r) => ({
      id: r.id,
      uuid: r.uuid ?? undefined,
      wordId: r.word_id,
      rating: r.rating,
      previousEaseFactor: r.previous_ease_factor,
      previousInterval: r.previous_interval,
      previousRepetitions: r.previous_repetitions,
      newEaseFactor: r.new_ease_factor,
      newInterval: r.new_interval,
      newRepetitions: r.new_repetitions,
      algorithm: r.algorithm === "fsrs" ? "fsrs" : "sm2",
      snapshot: parseHistorySnapshot(r.snapshot),
      reviewedAt: r.reviewed_at ?? undefined,
      word: r.word,
      translation: r.translation,
    })),
  };
}

export async function getUserAlgorithm(userId: number): Promise<SrsAlgorithm> {
  const row = await db
    .prepare(`SELECT srs_algorithm FROM users WHERE id = ?`)
    .get(userId);
  return row?.srs_algorithm === "fsrs" ? "fsrs" : "sm2";
}

export async function setUserAlgorithm(
  userId: number,
  algorithm: SrsAlgorithm
): Promise<void> {
  await db
    .prepare(`UPDATE users SET srs_algorithm = ? WHERE id = ?`)
    .run(algorithm, userId);
}

// New per-word position tracking for cross-device sync
export interface UserReviewState {
  userId: number;
  deviceId: string;
  mode: "review" | "new";
  wordId: number;
  position: number;
  updatedAt: string;
}

interface UserReviewStateRow {
  user_id: number;
  device_id: string;
  mode: "review" | "new";
  word_id: number;
  position: number;
  updated_at: string;
}

export async function getUserReviewState(
  userId: number,
  deviceId: string,
  mode: "review" | "new"
): Promise<UserReviewState[]> {
  const stmt = db.prepare(`
    SELECT * FROM user_review_state
    WHERE user_id = ? AND device_id = ? AND mode = ?
    ORDER BY position ASC
  `);
  const rows = toRows<UserReviewStateRow>(await stmt.all(userId, deviceId, mode));
  return rows.map((r) => ({
    userId: r.user_id,
    deviceId: r.device_id,
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
    INSERT INTO user_review_state (user_id, device_id, mode, word_id, position, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, mode, word_id) DO UPDATE SET
      position = excluded.position,
      updated_at = excluded.updated_at
  `);
  await stmt.run(state.userId, state.deviceId, state.mode, state.wordId, state.position, state.updatedAt);
}

export async function upsertUserReviewStates(
  states: UserReviewState[]
): Promise<void> {
  if (states.length === 0) return;

  // Batch into a single multi-row UPSERT to avoid one network round-trip per
  // row when running against a remote Turso database. SQLite's default limit is
  // 999 bound parameters; we bind 6 per row, so chunk at 100 rows (600 params).
  const CHUNK = 100;
  const ROW = "(?, ?, ?, ?, ?, ?)";

  for (let start = 0; start < states.length; start += CHUNK) {
    const chunk = states.slice(start, start + CHUNK);
    const valuesSql = Array.from({ length: chunk.length }, () => ROW).join(", ");
    const stmt = db.prepare(`
      INSERT INTO user_review_state (user_id, device_id, mode, word_id, position, updated_at)
      VALUES ${valuesSql}
      ON CONFLICT(user_id, device_id, mode, word_id) DO UPDATE SET
        position = excluded.position,
        updated_at = excluded.updated_at
    `);

    const params: unknown[] = [];
    for (const state of chunk) {
      params.push(
        state.userId,
        state.deviceId,
        state.mode,
        state.wordId,
        state.position,
        state.updatedAt
      );
    }

    await stmt.run(...params);
  }
}

/**
 * Replace all saved positions for one device/mode with the supplied set.
 *
 * `upsertUserReviewStates` only inserts or updates, so words that drop out of
 * the queue stay in the table forever. Over many sessions that turns into
 * hundreds of stale rows per device. Upserting first and then pruning anything
 * outside the current queue keeps the table (and the all-devices payload)
 * bounded, without leaving a window where the device has no saved state.
 */
export async function replaceUserReviewStates(
  userId: number,
  deviceId: string,
  mode: "review" | "new",
  states: UserReviewState[]
): Promise<void> {
  if (states.length === 0) {
    await clearUserReviewState(userId, deviceId, mode);
    return;
  }

  await upsertUserReviewStates(states);

  const existingStmt = db.prepare(`
    SELECT word_id FROM user_review_state
    WHERE user_id = ? AND device_id = ? AND mode = ?
  `);
  const existing = toRows<{ word_id: number }>(
    await existingStmt.all(userId, deviceId, mode)
  );
  const keep = new Set(states.map((state) => state.wordId));
  const stale = existing
    .map((row) => row.word_id)
    .filter((wordId) => !keep.has(wordId));

  // Chunk to stay well below SQLite's 999 bound-parameter limit.
  const CHUNK = 500;
  for (let start = 0; start < stale.length; start += CHUNK) {
    const chunk = stale.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const stmt = db.prepare(`
      DELETE FROM user_review_state
      WHERE user_id = ? AND device_id = ? AND mode = ?
        AND word_id IN (${placeholders})
    `);
    await stmt.run(userId, deviceId, mode, ...chunk);
  }
}

export async function clearUserReviewState(
  userId: number,
  deviceId: string,
  mode: "review" | "new"
): Promise<void> {
  const stmt = db.prepare(`
    DELETE FROM user_review_state WHERE user_id = ? AND device_id = ? AND mode = ?
  `);
  await stmt.run(userId, deviceId, mode);
}

export async function clearUserReviewMeta(
  userId: number,
  deviceId: string,
  mode: "review" | "new"
): Promise<void> {
  const stmt = db.prepare(`
    DELETE FROM user_review_meta WHERE user_id = ? AND device_id = ? AND mode = ?
  `);
  await stmt.run(userId, deviceId, mode);
}

export async function getUserReviewMeta(
  userId: number,
  deviceId: string,
  mode: "review" | "new"
): Promise<{ currentIndex: number; reviewedCount: number; updatedAt: string } | null> {
  const stmt = db.prepare(`
    SELECT current_index, reviewed_count, updated_at FROM user_review_meta
    WHERE user_id = ? AND device_id = ? AND mode = ?
  `);
  const row = toRow<{ current_index: number; reviewed_count: number; updated_at: string }>(await stmt.get(userId, deviceId, mode));
  if (!row) return null;
  return { currentIndex: row.current_index, reviewedCount: row.reviewed_count, updatedAt: row.updated_at };
}

export async function upsertUserReviewMeta(
  userId: number,
  deviceId: string,
  mode: "review" | "new",
  currentIndex: number,
  reviewedCount: number
): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO user_review_meta (user_id, device_id, mode, current_index, reviewed_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, mode) DO UPDATE SET
      current_index = excluded.current_index,
      reviewed_count = excluded.reviewed_count,
      updated_at = excluded.updated_at
  `);
  await stmt.run(userId, deviceId, mode, currentIndex, reviewedCount, new Date().toISOString());
}
