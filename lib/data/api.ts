import type {
  DictionaryResult,
  HistoryEntry,
  HistoryPage,
  IntervalPreview,
  Rating,
  ReviewWithWord,
  Settings,
  SrsAlgorithm,
  Stats,
  WordRecord,
  WordSort,
  WordsPage,
} from "./types";

export interface DataApi {
  getWords(options: {
    limit: number;
    offset: number;
    sort: WordSort;
  }): Promise<WordsPage>;
  getDueReviews(limit: number): Promise<ReviewWithWord[]>;
  getNewWords(limit: number): Promise<ReviewWithWord[]>;
  getStats(): Promise<Stats>;
  getHistory(options: { limit: number; offset: number }): Promise<HistoryPage>;
  getWordHistory(wordId: number): Promise<HistoryEntry[]>;
  getSettings(): Promise<Settings>;
  getIntervals(wordId: number): Promise<IntervalPreview>;

  submitReview(input: {
    wordId: number;
    uuid?: string;
    rating: Rating;
  }): Promise<{ wordId: number; response: Record<string, unknown> }>;
  saveWord(input: {
    word: string;
    translation: string;
    definitions?: string[];
    examples?: string[];
    phonetic?: string;
    audioUrl?: string;
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<WordRecord>;
  translate(input: {
    word: string;
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<DictionaryResult>;
  setSettings(input: { srsAlgorithm: SrsAlgorithm }): Promise<Settings>;
}

/** The subset needed to render the UI; both remote and local implement it. */
export type DataSource = "local" | "remote";
