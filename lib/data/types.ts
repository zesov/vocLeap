export type Rating = "again" | "hard" | "good" | "easy";
export type SrsAlgorithm = "sm2" | "fsrs";
export type WordSort = "date_desc" | "date_asc" | "alpha_asc" | "alpha_desc";

export interface WordRecord {
  id: number;
  uuid: string;
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

export interface FsrsCardState {
  stability: number;
  difficulty: number;
  state: number;
  lapses: number;
  reps: number;
  due: string;
  lastReview: string | null;
}

export interface ReviewWithWord {
  uuid: string;
  wordId: number;
  word: WordRecord;
  easeFactor: number;
  interval: number;
  repetitions: number;
  nextReviewDate: string;
  lastReviewed?: string;
  fsrsState?: FsrsCardState | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Stats {
  due: number;
  total: number;
  newWords: number;
}

export interface FsrsSnapshotState {
  stability: number;
  difficulty: number;
  state: number;
  lapses: number;
  reps: number;
  due: string;
}

export interface ReviewSnapshot {
  before: FsrsSnapshotState;
  after: FsrsSnapshotState;
}

export interface HistoryEntry {
  /** Server row id; local rows use `0` and are keyed by `uuid` instead. */
  id: number;
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
  snapshot?: ReviewSnapshot | null;
  reviewedAt: string;
  word: string;
  translation: string;
}

export interface WordsPage {
  words: WordRecord[];
  total: number;
  limit: number;
  offset: number;
  sort: WordSort;
  hasMore: boolean;
}

export interface HistoryPage {
  history: HistoryEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface IntervalPreview {
  algorithm: SrsAlgorithm;
  intervals: Record<Rating, number>;
}

export interface DictionarySource {
  id: "wiktionary" | "google-translate";
  label: string;
  url?: string;
}

export interface DictionaryDefinition {
  partOfSpeech: string;
  definition: string;
  examples: string[];
}

export interface DictionaryResult {
  word: string;
  translation: string;
  definitions: DictionaryDefinition[];
  phonetic?: string;
  audioUrl?: string;
  sourceLanguage: string;
  targetLanguage: string;
  sources?: {
    definitions: DictionarySource | null;
    translation: DictionarySource | null;
  };
}

export interface Settings {
  srsAlgorithm: SrsAlgorithm;
}
