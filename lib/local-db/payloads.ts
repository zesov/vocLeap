import type {
  HistoryPayload,
  ReviewPayload,
  WordPayload,
} from "../sync/types";

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function jsonArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Local row -> push payload (camelCase, JSON arrays, no server_id). */
export function wordRowToPayload(row: Record<string, unknown>): WordPayload {
  return {
    uuid: str(row.uuid),
    word: str(row.word),
    translation: str(row.translation),
    definitions: jsonArray(row.definitions),
    examples: jsonArray(row.examples),
    phonetic: nullableStr(row.phonetic),
    audioUrl: nullableStr(row.audio_url),
    sourceLanguage: str(row.source_language) || "en",
    targetLanguage: str(row.target_language) || "zh-CN",
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
  };
}

export function reviewRowToPayload(
  row: Record<string, unknown>,
  wordUuid: string
): ReviewPayload {
  return {
    wordUuid,
    easeFactor: Number(row.ease_factor ?? 2.5),
    interval: Number(row.interval ?? 0),
    repetitions: Number(row.repetitions ?? 0),
    nextReviewDate: str(row.next_review_date),
    lastReviewed: nullableStr(row.last_reviewed),
    stability: nullableNum(row.stability),
    difficulty: nullableNum(row.difficulty),
    fsrsState: nullableNum(row.fsrs_state),
    lapses: nullableNum(row.lapses),
    fsrsReps: nullableNum(row.fsrs_reps),
    fsrsLastReview: nullableStr(row.fsrs_last_review),
    updatedAt: str(row.updated_at),
  };
}

export function historyRowToPayload(
  row: Record<string, unknown>,
  wordUuid: string
): HistoryPayload {
  let snapshot: unknown = null;
  if (row.snapshot !== null && row.snapshot !== undefined) {
    try {
      snapshot = JSON.parse(String(row.snapshot));
    } catch {
      snapshot = null;
    }
  }
  return {
    uuid: str(row.uuid),
    wordUuid,
    rating: Number(row.rating),
    previousEaseFactor: Number(row.previous_ease_factor),
    previousInterval: Number(row.previous_interval),
    previousRepetitions: Number(row.previous_repetitions),
    newEaseFactor: Number(row.new_ease_factor),
    newInterval: Number(row.new_interval),
    newRepetitions: Number(row.new_repetitions),
    algorithm: row.algorithm === "fsrs" ? "fsrs" : "sm2",
    snapshot,
    reviewedAt: str(row.reviewed_at),
  };
}
