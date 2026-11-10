export type SyncEntity = "word" | "review" | "history" | "settings";
export type SyncOpKind = "upsert" | "delete";

export interface SyncOp {
  opId: string;
  entity: SyncEntity;
  op: SyncOpKind;
  payload: Record<string, unknown>;
}

export interface SyncOpResult {
  opId: string;
  /** `true` means settled: applied, superseded by a newer row, or a no-op. */
  accepted: boolean;
  reason?: string;
}

export interface SyncPushRequest {
  ops: SyncOp[];
}

export interface SyncPushResponse {
  results: SyncOpResult[];
}

export interface WordPayload {
  uuid: string;
  word: string;
  translation: string;
  definitions: string[];
  examples: string[];
  phonetic: string | null;
  audioUrl: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ReviewPayload {
  wordUuid: string;
  easeFactor: number;
  interval: number;
  repetitions: number;
  nextReviewDate: string;
  lastReviewed: string | null;
  stability: number | null;
  difficulty: number | null;
  fsrsState: number | null;
  lapses: number | null;
  fsrsReps: number | null;
  fsrsLastReview: string | null;
  updatedAt: string;
}

export interface HistoryPayload {
  uuid: string;
  wordUuid: string;
  rating: number;
  previousEaseFactor: number;
  previousInterval: number;
  previousRepetitions: number;
  newEaseFactor: number;
  newInterval: number;
  newRepetitions: number;
  algorithm: "sm2" | "fsrs";
  snapshot: unknown;
  reviewedAt: string;
}

export interface SettingsPayload {
  srsAlgorithm: "sm2" | "fsrs";
}

export const MAX_PUSH_OPS = 500;
export const PULL_PAGE_SIZE = 500;
