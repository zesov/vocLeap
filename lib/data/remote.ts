import { resolveClientTimezone } from "../timezone";
import type { DataApi } from "./api";
import type {
  DictionaryResult,
  HistoryEntry,
  HistoryPage,
  IntervalPreview,
  ReviewWithWord,
  Settings,
  WordRecord,
  WordsPage,
} from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function timezone(): string {
  return resolveClientTimezone(undefined) ?? "UTC";
}

export function createRemoteData(fetchImpl: typeof fetch = fetch): DataApi {
  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(url, {
      credentials: "same-origin",
      ...init,
    });
    if (!response.ok) {
      let message = `Request failed with ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // keep the status-based message
      }
      throw new ApiError(message, response.status);
    }
    return (await response.json()) as T;
  }

  function post<T>(url: string, body: unknown): Promise<T> {
    return request<T>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  return {
    getWords({ limit, offset, sort }) {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        sort,
      });
      return request<WordsPage>(`/api/words?${params.toString()}`);
    },

    async getDueReviews(limit) {
      return request<ReviewWithWord[]>(
        `/api/reviews?action=due&limit=${limit}`
      );
    },

    async getNewWords(limit) {
      return request<ReviewWithWord[]>(
        `/api/reviews?action=new&limit=${limit}`
      );
    },

    getStats() {
      return request("/api/reviews?action=stats");
    },

    getHistory({ limit, offset }) {
      return request<HistoryPage>(
        `/api/reviews?action=history&limit=${limit}&offset=${offset}`
      );
    },

    getWordHistory(wordId) {
      return request<HistoryEntry[]>(
        `/api/reviews?action=history&wordId=${wordId}`
      );
    },

    getSettings() {
      return request<Settings>("/api/settings");
    },

    getIntervals(wordId) {
      return request<IntervalPreview>(
        `/api/reviews?action=intervals&wordId=${wordId}`
      );
    },

    async submitReview({ wordId, rating }) {
      const response = await post<Record<string, unknown>>("/api/reviews", {
        wordId,
        rating,
        timezone: timezone(),
      });
      return { wordId, response };
    },

    saveWord(input) {
      return post<WordRecord>("/api/words", input);
    },

    translate(input) {
      return post<DictionaryResult>("/api/translate", input);
    },

    async setSettings(input) {
      return request<Settings>("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    },
  };
}

export const remoteData: DataApi = createRemoteData();
