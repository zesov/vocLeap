"use client";

import Link from "next/link";
import { useState, useEffect, useCallback, useRef, type MouseEvent } from "react";
import NavBar from "@/components/NavBar";
import { Card, CardHeader, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type Rating = "again" | "hard" | "good" | "easy";
type Mode = "review" | "new";
type QueueType = "due" | "new";

const RATING_CONFIG: Record<Rating, { label: string; color: string; description: string }> = {
  again: { label: "Again", color: "bg-red-600 hover:bg-red-700", description: "Complete blackout" },
  hard: { label: "Hard", color: "bg-orange-600 hover:bg-orange-700", description: "Difficult to recall" },
  good: { label: "Good", color: "bg-blue-600 hover:bg-blue-700", description: "Normal recall" },
  easy: { label: "Easy", color: "bg-green-600 hover:bg-green-700", description: "Instant recall" },
};

// Device ID persistence
function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return "";
  let deviceId = localStorage.getItem("vocleap_device_id");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem("vocleap_device_id", deviceId);
  }
  return deviceId;
}

// Legacy position-based storage (for backward compatibility)
type SavedPosition = { wordId: number; position: number };
const POSITION_KEY_PREFIX = "vocleap:review-position";

function positionKey(mode: Mode) {
  return `${POSITION_KEY_PREFIX}:${mode}`;
}

function readSavedPosition(mode: Mode): SavedPosition | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(positionKey(mode));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("wordId" in parsed) ||
      !("position" in parsed)
    ) {
      return null;
    }

    const { wordId, position } = parsed;
    if (typeof wordId !== "number" || typeof position !== "number") return null;

    return { wordId, position };
  } catch {
    return null;
  }
}

function writeSavedPosition(mode: Mode, position: SavedPosition) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(positionKey(mode), JSON.stringify(position));
  } catch {
    return;
  }
}

function clearSavedPosition(mode: Mode) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(positionKey(mode));
  } catch {
    return;
  }
}

// New queue-based storage with sync support
const QUEUE_STORAGE_KEY = (queueType: QueueType) => `review_${queueType}_state`;

interface QueueState {
  queueWordIds: number[];
  currentIndex: number;
  stats: { reviewed: number; again: number; hard: number; good: number; easy: number };
  updatedAt: string;
}

function readQueueState(queueType: QueueType): QueueState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY(queueType));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.queueWordIds || !Array.isArray(parsed.queueWordIds)) return null;
    return parsed as QueueState;
  } catch {
    return null;
  }
}

function writeQueueState(queueType: QueueType, state: QueueState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY(queueType), JSON.stringify(state));
  } catch {
    return;
  }
}

function clearQueueState(queueType: QueueType) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(QUEUE_STORAGE_KEY(queueType));
  } catch {
    return;
  }
}

function modeToQueueType(mode: Mode): QueueType {
  return mode === "review" ? "due" : "new";
}

export function ReviewSession() {
  const [mode, setMode] = useState<Mode>("review");
  const [reviews, setReviews] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reviewedBeforeBatch, setReviewedBeforeBatch] = useState(0);
  const [loadedMode, setLoadedMode] = useState<Mode | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [stats, setStats] = useState<any>({ due: 0, total: 0, newWords: 0 });
  const [loading, setLoading] = useState(true);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [pendingRating, setPendingRating] = useState<Rating | null>(null);

  // Sync state
  const [deviceId] = useState(() => getOrCreateDeviceId());
  const [synced, setSynced] = useState(false);
  const syncQueueRef = useRef<Record<QueueType, NodeJS.Timeout>>({ due: null, new: null } as any);

  const totalReviews = reviewedBeforeBatch + reviews.length;
  const currentQueueType = modeToQueueType(mode);

  // Initialize queue from localStorage (merged with server data)
  function initializeQueueFromStorage() {
    const queueType = modeToQueueType(mode);
    const saved = readQueueState(queueType);
    if (saved && saved.queueWordIds && saved.queueWordIds.length > 0) {
      setQueue(saved.queueWordIds);
      setCurrentIndex(saved.currentIndex || 0);
      setStats(saved.stats || { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
      setReviewedBeforeBatch(saved.stats?.reviewed || 0);
      return true;
    }
    return false;
  }

  // Set queue from word IDs (fetch full review objects if needed)
  function setQueue(wordIds: number[]) {
    // We have the word IDs, but need full review objects for display.
    // The reviews are already fetched in fetchReviews. This function just updates the index/stats.
    // The actual reviews array comes from the API fetch.
  }

  // Debounced save to server
  const saveToServer = useCallback(
    (queueType: QueueType, state: { queueWordIds: number[]; currentIndex: number; stats: any }) => {
      if (!deviceId || !synced) return;

      const existing = syncQueueRef.current[queueType];
      if (existing) clearTimeout(existing);

      const timeout = setTimeout(async () => {
        try {
          await fetch("/api/review-state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              deviceId,
              queueType,
              queueWordIds: state.queueWordIds,
              currentIndex: state.currentIndex,
              stats: state.stats,
            }),
          });
          // Update local updatedAt on success
          const local = readQueueState(queueType);
          if (local) {
            local.updatedAt = new Date().toISOString();
            writeQueueState(queueType, local);
          }
        } catch (e) {
          console.error("Sync save failed:", e);
        }
      }, 500);

      syncQueueRef.current[queueType] = timeout;
    },
    [deviceId, synced]
  );

  // Load from server on mount
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;

    async function load() {
      try {
        const [dueRes, newRes] = await Promise.all([
          fetch(`/api/review-state?queue=due&deviceId=${deviceId}`),
          fetch(`/api/review-state?queue=new&deviceId=${deviceId}`),
        ]);

        if (cancelled) return;

        if (dueRes.ok) {
          const dueData = await dueRes.json();
          const localDue = readQueueState("due");
          if (!localDue || (dueData.updatedAt && dueData.updatedAt > localDue.updatedAt)) {
            writeQueueState("due", dueData);
          }
        }
        if (newRes.ok) {
          const newData = await newRes.json();
          const localNew = readQueueState("new");
          if (!localNew || (newData.updatedAt && newData.updatedAt > localNew.updatedAt)) {
            writeQueueState("new", newData);
          }
        }

        // Re-initialize queue from merged state
        initializeQueueFromStorage();
        setSynced(true);
      } catch (e) {
        console.error("Sync load failed:", e);
        setSynced(true); // Proceed with localStorage only
      }
    }

    load();
    return () => { cancelled = true; };
  }, [deviceId]);

  const fetchReviews = async () => {
    setLoading(true);
    try {
      const [reviewsRes, statsRes] = await Promise.all([
        fetch(`/api/reviews?action=${mode}&limit=50`),
        fetch("/api/reviews?action=stats"),
      ]);

      const reviewsData = await reviewsRes.json();
      const statsData = await statsRes.json();

      // Auto-switch to new words mode if no due reviews but there are new words
      if (mode === "review" && statsData.due === 0 && statsData.newWords > 0) {
        setMode("new");
        return;
      }

      setReviews(reviewsData);
      setStats(statsData);

      // Try to restore from queue state first (server-synced)
      const restored = initializeQueueFromStorage();

      if (!restored) {
        // Fallback to legacy position-based restore
        const saved = readSavedPosition(mode);
        const savedIndex = saved
          ? reviewsData.findIndex((review: { wordId: number }) => review.wordId === saved.wordId)
          : -1;
        const restoredOffset =
          saved && savedIndex >= 0 ? Math.max(0, saved.position - savedIndex - 1) : 0;

        setCurrentIndex(saved && savedIndex >= 0 ? savedIndex : 0);
        setReviewedBeforeBatch(restoredOffset);
      }

      setShowAnswer(false);
      setSessionComplete(reviewsData.length === 0);
      setLoadedMode(mode);

      if (reviewsData.length === 0) {
        clearSavedPosition(mode);
        clearQueueState(currentQueueType);
      }
    } catch (error) {
      console.error("Failed to fetch reviews:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReviews();
  }, [mode]);

  // Save position to legacy localStorage (for backward compat)
  useEffect(() => {
    if (loading || sessionComplete || loadedMode !== mode) return;

    const review = reviews[currentIndex];
    if (!review) return;

    writeSavedPosition(mode, {
      wordId: review.wordId,
      position: reviewedBeforeBatch + currentIndex + 1,
    });
  }, [loading, sessionComplete, loadedMode, mode, reviews, currentIndex, reviewedBeforeBatch]);

  // Save queue state to localStorage (with updatedAt) and sync to server
  const saveQueueState = useCallback(() => {
    const queueType = modeToQueueType(mode);
    const queueWordIds = reviews.map((r: any) => r.wordId);
    const newStats = {
      reviewed: reviewedBeforeBatch + currentIndex + (showAnswer ? 1 : 0),
      again: 0, // These would need to be tracked separately
      hard: 0,
      good: 0,
      easy: 0,
    };
    // Merge with existing stats for rating counts
    const existingStats = readQueueState(queueType)?.stats || { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 };
    const mergedStats = { ...existingStats, reviewed: newStats.reviewed };

    const state: QueueState = {
      queueWordIds,
      currentIndex,
      stats: mergedStats,
      updatedAt: new Date().toISOString(),
    };

    writeQueueState(queueType, state);
    saveToServer(queueType, state);
  }, [mode, reviews, currentIndex, reviewedBeforeBatch, showAnswer, saveToServer]);

  const handleRate = useCallback(async (rating: Rating) => {
    const currentReview = reviews[currentIndex];
    if (!currentReview || pendingRating) return;

    setPendingRating(rating);

    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wordId: currentReview.wordId, rating }),
      });

      if (!response.ok) {
        throw new Error("Failed to submit review");
      }

      // Update rating counts in stats
      setStats((prev: any) => {
        const next = { ...prev };
        if (mode === "review") {
          next.due = Math.max(0, (next.due || 0) - 1);
        }
        return next;
      });

      // Update queue state stats with rating
      const queueType = modeToQueueType(mode);
      const existingState = readQueueState(queueType);
      if (existingState) {
        const ratingKey = rating === "again" ? "again" : rating === "hard" ? "hard" : rating === "good" ? "good" : "easy";
        existingState.stats = {
          ...existingState.stats,
          [ratingKey]: (existingState.stats[ratingKey] || 0) + 1,
          reviewed: existingState.stats.reviewed + 1,
        };
        existingState.currentIndex = currentIndex + 1;
        existingState.updatedAt = new Date().toISOString();
        writeQueueState(queueType, existingState);
        saveToServer(queueType, existingState);
      }

      if (currentIndex < reviews.length - 1) {
        setCurrentIndex(currentIndex + 1);
        setShowAnswer(false);
      } else {
        setSessionComplete(true);
        clearSavedPosition(mode);
        clearQueueState(queueType);
      }
    } catch (error) {
      console.error("Review submission error:", error);
      alert("Failed to submit review. Please try again.");
    } finally {
      setPendingRating(null);
    }
  }, [reviews, currentIndex, pendingRating, mode, saveToServer]);

  // Save queue state when currentIndex changes (debounced via saveToServer)
  useEffect(() => {
    if (loading || sessionComplete || !synced) return;
    saveQueueState();
  }, [currentIndex, reviewedBeforeBatch, showAnswer, loading, sessionComplete, synced, saveQueueState]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === " ") {
        event.preventDefault();
        setShowAnswer((prev) => !prev);
        return;
      }
      if (!showAnswer) return;
      const ratingMap: Record<string, Rating> = {
        1: "again",
        2: "hard",
        3: "good",
        4: "easy",
      };
      const rating = ratingMap[event.key];
      if (rating) {
        handleRate(rating);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleRate, showAnswer]);

  const formatInterval = (interval: number) => {
    if (interval < 1) return "< 1 day";
    if (interval === 1) return "1 day";
    if (interval < 7) return `${interval} days`;
    if (interval < 30) return `${Math.round(interval / 7)} weeks`;
    if (interval < 365) return `${Math.round(interval / 30)} months`;
    return `${Math.round(interval / 365)} years`;
  };

  const handleCardToggle = (event: MouseEvent<HTMLDivElement>) => {
    if (!window.matchMedia("(max-width: 767px)").matches || pendingRating) return;
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest("button, audio, a, input, select, textarea")) return;
    setShowAnswer((prev) => !prev);
  };

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  if (sessionComplete || reviews.length === 0) {
    return (
      <div className="max-w-2xl mx-auto text-center py-12">
        <Card variant="outlined">
          <CardContent className="py-12">
            <svg className="mx-auto h-16 w-16 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h2 className="mt-4 text-2xl font-bold text-gray-900 dark:text-white">Session Complete!</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              {reviews.length === 0
                ? mode === "new"
                  ? "No new words to learn. All words have been reviewed!"
                  : "No words due for review right now. Come back later!"
                : `You reviewed ${totalReviews} word${totalReviews > 1 ? "s" : ""}.`}
            </p>
            <div className="mt-6 flex gap-4 justify-center">
              <Button onClick={() => setMode(mode === "review" ? "new" : "review")} variant="outline">
                Switch to {mode === "review" ? "New Words" : "Review"}
              </Button>
              <Button onClick={fetchReviews} variant="outline">
                Check Again
              </Button>
              <Button onClick={() => (window.location.href = "/dictionary")}>
                Look Up New Words
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentReview = reviews[currentIndex];
  if (!currentReview) {
    return (
      <div className="max-w-2xl mx-auto text-center py-12">
        <Card variant="outlined">
          <CardContent className="py-12">
            <h2 className="mt-4 text-2xl font-bold text-gray-900 dark:text-white">No words to review</h2>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentPosition = reviewedBeforeBatch + currentIndex + 1;
  const progress = totalReviews > 0 ? (currentPosition / totalReviews) * 100 : 0;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400 mb-2">
        <span>Card {currentPosition} of {totalReviews}</span>
        <span>{Math.round(progress)}%</span>
        <span className="text-blue-600 dark:text-blue-400 font-medium">{mode === "review" ? "Review" : "New Words"}</span>
      </div>
      <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>

      <div className="grid grid-cols-3 gap-4 text-center">
        <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.due}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">Due Now</p>
        </div>
        <div className="p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">{stats.total}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">Total Saved</p>
        </div>
        <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
          <p className="text-2xl font-bold text-purple-600 dark:text-purple-400">{stats.newWords}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">New Words</p>
        </div>
      </div>

      <Card variant="elevated">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {mode === "review" ? "Review" : "New Word"} {currentPosition} of {totalReviews}
            </span>
            {currentReview?.word?.phonetic && (
              <span className="text-gray-500 dark:text-gray-400 text-sm">
                /{currentReview.word.phonetic}/
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent
          className="pt-0 touch-manipulation cursor-pointer md:cursor-default"
          onClick={handleCardToggle}
        >
          <div className="text-center">
            <div className="relative inline-block px-12">
              <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
                {currentReview?.word?.word || "Word"}
              </h1>
              {currentReview?.word?.word && (
                <Link
                  href={`/dictionary?word=${encodeURIComponent(currentReview.word.word)}`}
                  aria-label={`Look up ${currentReview.word.word} in the dictionary`}
                  className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-blue-400"
                >
                  <svg
                    aria-hidden="true"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </Link>
              )}
            </div>
            {currentReview?.word?.audioUrl && (
              <audio controls src={currentReview?.word?.audioUrl} className="mb-4" />
            )}

            {!showAnswer ? (
              <Button
                onClick={() => setShowAnswer(true)}
                size="lg"
                className="w-full max-w-xs"
                variant="primary"
              >
                Show Answer
              </Button>
            ) : (
              <div className="space-y-4">
                <div className="text-2xl text-blue-600 dark:text-blue-400 font-medium">
                  {currentReview?.word?.translation || "No translation"}
                </div>

                {currentReview?.word?.definitions.length > 0 && (
                  <div className="text-left text-sm text-gray-600 dark:text-gray-300 space-y-1">
                    {currentReview?.word?.definitions.slice(0, 3).map((def: any, i: number) => (
                      <p key={i} className="text-gray-700 dark:text-gray-300">{def}</p>
                    ))}
                  </div>
                )}

                {currentReview?.word?.examples.length > 0 && (
                  <div className="text-left text-sm text-gray-500 dark:text-gray-400 italic space-y-1">
                    {currentReview?.word?.examples.slice(0, 2).map((ex: string, i: number) => (
                      <p key={i} className="text-gray-700 dark:text-gray-300">"{ex}"</p>
                    ))}
                  </div>
                )}

                <div className="pt-4">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                    Next review in: <span className="font-medium">{formatInterval(currentReview.interval)}</span>
                    {currentReview.repetitions > 0 && (
                      <> • Repetition #{currentReview.repetitions} • EF: {currentReview.easeFactor.toFixed(2)}</>
                    )}
                  </p>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {(["again", "hard", "good", "easy"] as Rating[]).map((rating) => (
                      <Button
                        key={rating}
                        onClick={() => handleRate(rating)}
                        loading={pendingRating === rating}
                        variant="primary"
                        className={`${RATING_CONFIG[rating].color} text-white py-3 text-sm`}
                        disabled={pendingRating !== null}
                      >
                        {RATING_CONFIG[rating].label}
                      </Button>
                    ))}
                  </div>

                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                    {RATING_CONFIG.again.description} → {RATING_CONFIG.easy.description}
                  </p>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="hidden md:block text-center text-xs text-gray-400 dark:text-gray-500">
        <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">Space</kbd> Show Answer &nbsp;
        <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">1</kbd> Again &nbsp;
        <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">2</kbd> Hard &nbsp;
        <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">3</kbd> Good &nbsp;
        <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">4</kbd> Easy
      </div>
    </div>
  );
}
