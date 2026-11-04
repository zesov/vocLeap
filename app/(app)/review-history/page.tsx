"use client";

import { useState, useEffect } from "react";
import NavBar from "@/components/NavBar";
import { Card, CardContent } from "@/components/ui/Card";

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

  useEffect(() => {
    fetch("/api/reviews?action=history")
      .then((res) => res.json())
      .then((data: HistoryEntry[]) => {
        setHistory(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Fetch review history error:", err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <NavBar />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 text-center">
          <p className="text-gray-500 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <NavBar />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Review History</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Your spaced repetition review history
          </p>
        </div>

        {history.length === 0 ? (
          <Card variant="outlined">
            <CardContent className="py-12 text-center">
              <p className="text-gray-500 dark:text-gray-400">
                No review history yet. Start reviewing words to build your history!
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-4 pl-4 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Word</th>
                  <th className="py-4 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Translation</th>
                  <th className="py-4 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Rating</th>
                  <th className="py-4 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Ease Factor</th>
                  <th className="py-4 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Interval</th>
                  <th className="py-4 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Reps</th>
                  <th className="py-4 pr-4 text-sm font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Reviewed At</th>
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
                      <td className="py-3 pl-4 font-medium text-gray-900 dark:text-white whitespace-nowrap">
                        {entry.word}
                      </td>
                      <td className="py-3 text-gray-600 dark:text-gray-300 max-w-xs break-words whitespace-normal">{entry.translation}</td>
                      <td className="py-3 whitespace-nowrap">
                        <span className={`font-medium ${ratingInfo.color}`}>
                          {ratingInfo.label}
                        </span>
                      </td>
                      <td className="py-3 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                        {entry.previousEaseFactor.toFixed(2)} → {entry.newEaseFactor.toFixed(2)}
                      </td>
                      <td className="py-3 text-gray-600 dark:text-gray-300 whitespace-nowrap">{entry.newInterval} day{entry.newInterval !== 1 ? "s" : ""}</td>
                      <td className="py-3 text-gray-600 dark:text-gray-300 whitespace-nowrap">{entry.newRepetitions}</td>
                      <td className="py-3 pr-4 text-sm text-gray-400 dark:text-gray-500 whitespace-nowrap">
                        {new Date(entry.reviewedAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}