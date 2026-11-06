"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

const ITEMS_PER_PAGE = 30;

type RatingLabel = Record<number, { label: string; color: string }>;

const RATING_LABELS: RatingLabel = {
  0: { label: "Again", color: "text-red-600 dark:text-red-400" },
  1: { label: "Hard", color: "text-orange-600 dark:text-orange-400" },
  2: { label: "Hard", color: "text-orange-600 dark:text-orange-400" },
  3: { label: "Good", color: "text-blue-600 dark:text-blue-400" },
  4: { label: "Easy", color: "text-green-600 dark:text-green-400" },
  5: { label: "Perfect", color: "text-green-700 dark:text-green-300" },
};

type HistoryEntry = {
  id: number;
  wordId: number;
  rating: number;
  previousEaseFactor: number;
  previousInterval: number;
  previousRepetitions: number;
  newEaseFactor: number;
  newInterval: number;
  newRepetitions: number;
  reviewedAt: string;
  word: string;
  translation: string;
};

export default function ReviewHistoryPage() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const observerRef = useRef<HTMLDivElement>(null);

  const fetchHistory = useCallback(
    async (nextOffset: number = 0, append: boolean = false) => {
      if (append) {
        setLoadingMore(true);
      }

      try {
        const res = await fetch(
          `/api/reviews?action=history&limit=${ITEMS_PER_PAGE}&offset=${nextOffset}`
        );
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }

        const data = await res.json();
        setHistory((prev) =>
          append ? [...prev, ...data.history] : data.history
        );
        setHasMore(data.hasMore);
        setOffset(data.offset + data.history.length);
        setError(null);
      } catch (err) {
        console.error("Fetch review history error:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load review history"
        );
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchHistory(0, false);
  }, [fetchHistory]);

  const handleLoadMore = useCallback(() => {
    if (hasMore && !loading && !loadingMore && !error) {
      fetchHistory(offset, true);
    }
  }, [hasMore, loading, loadingMore, error, offset, fetchHistory]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          handleLoadMore();
        }
      },
      { threshold: 0.1 }
    );

    if (observerRef.current) {
      observer.observe(observerRef.current);
    }

    return () => observer.disconnect();
  }, [handleLoadMore]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 text-center">
        <p className="text-gray-500 dark:text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Review History</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Your spaced repetition review history
        </p>
      </div>

      {error && (
        <Card variant="destructive" className="mb-4">
          <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (history.length === 0) {
                  setLoading(true);
                }
                fetchHistory(
                  history.length > 0 ? offset : 0,
                  history.length > 0
                );
              }}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {history.length === 0 ? (
        !error && (
          <Card variant="outlined">
            <CardContent className="py-12 text-center">
              <p className="text-gray-500 dark:text-gray-400">
                No review history yet. Start reviewing words to build your history!
              </p>
            </CardContent>
          </Card>
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="p-1 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Word</th>
                  <th className="p-1 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Translation</th>
                  <th className="p-1 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Rating</th>
                  <th className="p-1 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Ease Factor</th>
                  <th className="p-1 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Interval</th>
                  <th className="p-1 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Reps</th>
                  <th className="p-1 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Reviewed At</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry: HistoryEntry) => {
                  const ratingInfo = RATING_LABELS[entry.rating] || RATING_LABELS[3];
                  return (
                    <tr
                      key={entry.id}
                      className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                    >
                      <td className="p-1 font-medium text-gray-900 dark:text-white whitespace-nowrap">
                        {entry.word}
                      </td>
                      <td className="p-1 text-gray-600 dark:text-gray-300 max-w-xs break-words whitespace-normal">{entry.translation}</td>
                      <td className="p-1 whitespace-nowrap">
                        <span className={`font-medium ${ratingInfo.color}`}>
                          {ratingInfo.label}
                        </span>
                      </td>
                      <td className="p-1 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                        {entry.previousEaseFactor.toFixed(2)} → {entry.newEaseFactor.toFixed(2)}
                      </td>
                      <td className="p-1 text-gray-600 dark:text-gray-300 whitespace-nowrap">{entry.newInterval} day{entry.newInterval !== 1 ? "s" : ""}</td>
                      <td className="p-1 text-gray-600 dark:text-gray-300 whitespace-nowrap">{entry.newRepetitions}</td>
                      <td className="p-1 text-sm text-gray-400 dark:text-gray-500 whitespace-nowrap">
                        {new Date(entry.reviewedAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div className="flex justify-center py-8">
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 bg-blue-600 rounded-full animate-pulse" />
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  Loading more history...
                </span>
              </div>
            </div>
          )}

          <div ref={observerRef} className="h-1" />
        </>
      )}
    </div>
  );
}