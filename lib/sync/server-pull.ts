import type { DatabaseAdapter } from "../db/adapter";
import type { SyncCursor } from "./cursor";
import {
  PULL_PAGE_SIZE,
  type HistoryPayload,
  type ReviewPayload,
  type SettingsPayload,
  type WordPayload,
} from "./types";

export interface PullPage {
  words: WordPayload[];
  reviews: ReviewPayload[];
  history: HistoryPayload[];
  settings: SettingsPayload;
  nextCursor: SyncCursor;
}

function parseJsonArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export async function pullPage(
  db: DatabaseAdapter,
  userId: number,
  cursor: SyncCursor,
  limit: number = PULL_PAGE_SIZE
): Promise<PullPage> {
  const wordRows = await db
    .prepare(`
      SELECT id, uuid, word, translation, definitions, examples, phonetic,
             audio_url, source_language, target_language, created_at,
             updated_at, deleted_at
      FROM words
      WHERE user_id = ? AND uuid IS NOT NULL
        AND (
          julianday(updated_at) > julianday(?)
          OR (julianday(updated_at) = julianday(?) AND id > ?)
        )
      ORDER BY julianday(updated_at), id
      LIMIT ?
    `)
    .all(userId, cursor.wTs, cursor.wTs, cursor.wId, limit);

  const reviewRows = await db
    .prepare(`
      SELECT r.id, r.word_id, w.uuid AS word_uuid, r.ease_factor, r.interval,
             r.repetitions, r.next_review_date, r.last_reviewed, r.stability,
             r.difficulty, r.fsrs_state, r.lapses, r.fsrs_reps,
             r.fsrs_last_review, r.updated_at
      FROM reviews r
      JOIN words w ON w.id = r.word_id
      WHERE w.user_id = ? AND w.uuid IS NOT NULL
        AND (
          julianday(r.updated_at) > julianday(?)
          OR (julianday(r.updated_at) = julianday(?) AND r.id > ?)
        )
      ORDER BY julianday(r.updated_at), r.id
      LIMIT ?
    `)
    .all(userId, cursor.rTs, cursor.rTs, cursor.rId, limit);

  const historyRows = await db
    .prepare(`
      SELECT rh.id, rh.uuid, rh.word_id, w.uuid AS word_uuid, rh.rating,
             rh.previous_ease_factor, rh.previous_interval,
             rh.previous_repetitions, rh.new_ease_factor, rh.new_interval,
             rh.new_repetitions, rh.algorithm, rh.snapshot, rh.reviewed_at
      FROM review_history rh
      JOIN words w ON w.id = rh.word_id
      WHERE w.user_id = ? AND rh.uuid IS NOT NULL AND rh.id > ?
      ORDER BY rh.id
      LIMIT ?
    `)
    .all(userId, cursor.hId, limit);

  const userRow = await db
    .prepare("SELECT srs_algorithm FROM users WHERE id = ?")
    .get(userId);

  const words: WordPayload[] = wordRows.map((row) => ({
    uuid: str(row.uuid),
    serverId: Number(row.id),
    word: str(row.word),
    translation: str(row.translation),
    definitions: parseJsonArray(row.definitions),
    examples: parseJsonArray(row.examples),
    phonetic: nullableStr(row.phonetic),
    audioUrl: nullableStr(row.audio_url),
    sourceLanguage: str(row.source_language) || "en",
    targetLanguage: str(row.target_language) || "zh-CN",
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  }));

  const reviews: ReviewPayload[] = reviewRows.map((row) => ({
    wordUuid: str(row.word_uuid),
    easeFactor: Number(row.ease_factor),
    interval: Number(row.interval),
    repetitions: Number(row.repetitions),
    nextReviewDate: str(row.next_review_date),
    lastReviewed: nullableStr(row.last_reviewed),
    stability: nullableNum(row.stability),
    difficulty: nullableNum(row.difficulty),
    fsrsState: nullableNum(row.fsrs_state),
    lapses: nullableNum(row.lapses),
    fsrsReps: nullableNum(row.fsrs_reps),
    fsrsLastReview: nullableStr(row.fsrs_last_review),
    updatedAt: str(row.updated_at),
  }));

  const history: HistoryPayload[] = historyRows.map((row) => ({
    uuid: str(row.uuid),
    wordUuid: str(row.word_uuid),
    rating: Number(row.rating),
    previousEaseFactor: Number(row.previous_ease_factor),
    previousInterval: Number(row.previous_interval),
    previousRepetitions: Number(row.previous_repetitions),
    newEaseFactor: Number(row.new_ease_factor),
    newInterval: Number(row.new_interval),
    newRepetitions: Number(row.new_repetitions),
    algorithm: row.algorithm === "fsrs" ? "fsrs" : "sm2",
    snapshot: parseJson(row.snapshot),
    reviewedAt: str(row.reviewed_at),
  }));

  const nextCursor: SyncCursor = { ...cursor };
  const lastWord = wordRows[wordRows.length - 1];
  if (lastWord) {
    nextCursor.wTs = str(lastWord.updated_at);
    nextCursor.wId = Number(lastWord.id);
  }
  const lastReview = reviewRows[reviewRows.length - 1];
  if (lastReview) {
    nextCursor.rTs = str(lastReview.updated_at);
    nextCursor.rId = Number(lastReview.id);
  }
  const lastHistory = historyRows[historyRows.length - 1];
  if (lastHistory) {
    nextCursor.hId = Number(lastHistory.id);
  }

  return {
    words,
    reviews,
    history,
    settings: {
      srsAlgorithm: userRow?.srs_algorithm === "fsrs" ? "fsrs" : "sm2",
    },
    nextCursor,
  };
}
