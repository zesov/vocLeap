"use client";

import Link from "next/link";
import { useState, useEffect, useCallback, useRef, type MouseEvent } from "react";
import { Card, CardHeader, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type Rating = "again" | "hard" | "good" | "easy";
type Mode = "review" | "new";

const RATING_CONFIG: Record<Rating, { label: string; color: string; description: string }> = {
  again: { label: "Again", color: "bg-red-600 hover:bg-red-700", description: "Complete blackout" },
  hard: { label: "Hard", color: "bg-orange-600 hover:bg-orange-700", description: "Difficult to recall" },
  good: { label: "Good", color: "bg-blue-600 hover:bg-blue-700", description: "Normal recall" },
  easy: { label: "Easy", color: "bg-green-600 hover:bg-green-700", description: "Instant recall" },
};

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

// New per-word position storage for cross-device sync
const POSITIONS_STORAGE_KEY = (mode: Mode) => `review_${mode}_positions`;

const DEVICE_ID_KEY = "vocleap_device_id";

function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return "";
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    // Fallback for browsers without crypto.randomUUID()
    deviceId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

// Constants for debouncing
const SYNC_DEBOUNCE_MS = 500;
const LOCAL_STORAGE_DEBOUNCE_MS = 100;

interface Review {
  wordId: number;
  word: {
    word: string;
    translation: string;
    definitions: string[];
    examples: string[];
    phonetic?: string;
    audioUrl?: string;
    sourceLanguage: string;
    targetLanguage: string;
  };
  easeFactor: number;
  interval: number;
  repetitions: number;
  nextReviewDate: string;
}

interface Stats {
  due: number;
  total: number;
  newWords: number;
}

interface PositionState {
  positions: Record<number, number>; // wordId -> position in queue
  currentIndex: number; // current index in the remaining queue
  reviewedCount: number; // number of words reviewed in this session
  updatedAt: string;
}

interface ServerState {
  mode: "review" | "new";
  deviceId: string;
  states: Array<{ wordId: number; position: number; updatedAt: string }>;
  meta: { currentIndex: number; reviewedCount: number; updatedAt: string } | null;
}

function readPositionState(mode: Mode): PositionState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(POSITIONS_STORAGE_KEY(mode));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.positions || typeof parsed.positions !== "object") return null;
    // Backward compat: add missing fields
    return {
      positions: parsed.positions,
      currentIndex: parsed.currentIndex ?? 0,
      reviewedCount: parsed.reviewedCount ?? 0,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    } as PositionState;
  } catch {
    return null;
  }
}

function writePositionState(mode: Mode, state: PositionState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(POSITIONS_STORAGE_KEY(mode), JSON.stringify(state));
  } catch {
    return;
  }
}

function clearPositionState(mode: Mode) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(POSITIONS_STORAGE_KEY(mode));
  } catch {
    return;
  }
}

// Merge server state with local state (last-write-wins per word)
function mergeServerState(
  mode: Mode,
  serverData: ServerState,
  localState: PositionState | null
): PositionState {
  const now = new Date().toISOString();
  
  if (!localState) {
    // No local state - use server state
    const positions: Record<number, number> = {};
    for (const s of serverData.states) {
      positions[s.wordId] = s.position;
    }
    const maxUpdatedAt = serverData.states.length > 0
      ? serverData.states.reduce((max, s) => s.updatedAt > max ? s.updatedAt : max, serverData.states[0].updatedAt)
      : now;
    return {
      positions,
      currentIndex: serverData.meta?.currentIndex ?? 0,
      reviewedCount: serverData.meta?.reviewedCount ?? 0,
      updatedAt: maxUpdatedAt,
    };
  }

  // Merge: take latest per word
  const mergedPositions = { ...localState.positions };
  let maxUpdatedAt = localState.updatedAt;

  for (const s of serverData.states) {
    const localUpdated = localState.updatedAt;
    const serverUpdated = s.updatedAt;
    // `in` rather than a truthiness check: position 0 is a valid position.
    if (!(s.wordId in mergedPositions) || (serverUpdated && (!localUpdated || serverUpdated > localUpdated))) {
      mergedPositions[s.wordId] = s.position;
    }
    if (serverUpdated && serverUpdated > maxUpdatedAt) {
      maxUpdatedAt = serverUpdated;
    }
  }

  // Also check meta updatedAt
  if (serverData.meta && serverData.meta.updatedAt && serverData.meta.updatedAt > maxUpdatedAt) {
    maxUpdatedAt = serverData.meta.updatedAt;
  }

  return {
    positions: mergedPositions,
    currentIndex: serverData.meta?.currentIndex ?? localState.currentIndex,
    reviewedCount: serverData.meta?.reviewedCount ?? localState.reviewedCount,
    updatedAt: maxUpdatedAt,
  };
}

export function ReviewSession() {
  const [mode, setMode] = useState<Mode>("review");
  const [reviews, setReviews] = useState<Review[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reviewedBeforeBatch, setReviewedBeforeBatch] = useState(0);
  const [loadedMode, setLoadedMode] = useState<Mode | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [stats, setStats] = useState<Stats>({ due: 0, total: 0, newWords: 0 });
  const [loading, setLoading] = useState(true);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [pendingRating, setPendingRating] = useState<Rating | null>(null);

  // Sync state
  const [deviceId] = useState(() => getOrCreateDeviceId());
  const [synced, setSynced] = useState(false);
  const syncPositionsRef = useRef<Record<Mode, NodeJS.Timeout>>({ review: null, new: null } as any);
  const localStorageDebounceRef = useRef<Record<Mode, NodeJS.Timeout>>({ review: null, new: null } as any);

  const totalReviews = reviewedBeforeBatch + reviews.length;

  // Initialize queue order from saved positions (localStorage or server-synced).
  // The queue itself comes from the API (`review` = due, `new` = never
  // reviewed), so saved positions can only reorder it — never add words back.
  function initializeQueueFromPositions(reviewsData: Review[]) {
    const saved = readPositionState(mode);
    if (!saved || Object.keys(saved.positions).length === 0) {
      return false;
    }

    const withPosition = reviewsData
      .filter((r) => saved.positions[r.wordId] !== undefined)
      .sort((a, b) => saved.positions[a.wordId] - saved.positions[b.wordId]);
    const withoutPosition = reviewsData.filter(
      (r) => saved.positions[r.wordId] === undefined
    );

    setReviews([...withPosition, ...withoutPosition]);
    // Words already reviewed in this session are gone from the fresh queue, so
    // the next card is always the first remaining one.
    setCurrentIndex(0);
    setReviewedBeforeBatch(Math.max(0, saved.reviewedCount ?? 0));

    return true;
  }

  // Debounced save positions to server
  const savePositionsToServer = useCallback(
    (mode: Mode, positions: Record<number, number>, currentIndex: number, reviewedCount: number) => {
      if (!synced || !deviceId) return;

      const existing = syncPositionsRef.current[mode];
      if (existing) clearTimeout(existing);

      const timeout = setTimeout(async () => {
        try {
          const states = Object.entries(positions).map(([wordId, position]) => ({
            wordId: Number(wordId),
            position,
            updatedAt: new Date().toISOString(),
          }));

          const meta = {
            currentIndex,
            reviewedCount,
          };

          await fetch("/api/review-state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId, mode, states, meta }),
          });

          // Update local updatedAt on success
          const local = readPositionState(mode);
          if (local) {
            local.updatedAt = new Date().toISOString();
            writePositionState(mode, local);
          }
        } catch (e) {
          console.error("Sync save failed:", e);
        }
      }, SYNC_DEBOUNCE_MS);

      syncPositionsRef.current[mode] = timeout;
    },
    [synced, deviceId]
  );

  // Drop the synced session state for this device. Called when a queue is
  // finished or empty so the next session starts from zero progress instead of
  // inheriting a stale reviewed count.
  const clearServerState = useCallback(
    async (mode: Mode) => {
      const pendingSync = syncPositionsRef.current[mode];
      if (pendingSync) clearTimeout(pendingSync);
      const pendingLocal = localStorageDebounceRef.current[mode];
      if (pendingLocal) clearTimeout(pendingLocal);
      if (!deviceId) return;

      try {
        await fetch(
          `/api/review-state?mode=${mode}&deviceId=${encodeURIComponent(deviceId)}`,
          { method: "DELETE" }
        );
      } catch (e) {
        console.error("Sync clear failed:", e);
      }
    },
    [deviceId]
  );

  // Load from server on mount (fetch per-word positions for cross-device sync)
  // Uses allDevices=true on initial load to get latest state across all devices
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;

    // Don't block the queue forever if the state request is slow/unreachable.
    // The timeout only flips `synced`; the queue itself then loads from
    // localStorage via the effect below.
    const timeout = setTimeout(() => {
      if (!cancelled) setSynced(true);
    }, 3000);

    async function load() {
      try {
        // On initial load, fetch latest state across ALL devices for cross-device sync
        // Subsequent writes will use the current deviceId
        const [reviewRes, newRes] = await Promise.all([
          fetch(`/api/review-state?mode=review&allDevices=true`),
          fetch(`/api/review-state?mode=new&allDevices=true`),
        ]);

        if (cancelled) return;

        if (reviewRes.ok) {
          const reviewData = await reviewRes.json();
          const localReview = readPositionState("review");
          const merged = mergeServerState("review", reviewData, localReview);
          writePositionState("review", merged);
        }
        if (newRes.ok) {
          const newData = await newRes.json();
          const localNew = readPositionState("new");
          const merged = mergeServerState("new", newData, localNew);
          writePositionState("new", merged);
        }
      } catch (e) {
        console.error("Sync load failed:", e);
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setSynced(true); // Proceed with localStorage only
      }
    }

    load();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [deviceId]);

  const fetchReviews = async () => {
    setLoading(true);
    try {
      // Authentication is enforced by app/(app)/layout.tsx; if the session
      // expired while the page was open the API answers 401 and we stop here
      // instead of making a second /api/auth/me round trip first.
      // The queue always comes from the mode endpoint so it only contains
      // words that are actually due (`review`) or never reviewed (`new`).
      // Saved positions are applied afterwards, purely to restore ordering.
      const reviewsParams = new URLSearchParams({ action: mode, limit: "50" });

      const [reviewsRes, statsRes] = await Promise.all([
        fetch(`/api/reviews?${reviewsParams}`),
        fetch("/api/reviews?action=stats"),
      ]);

      if (!reviewsRes.ok || !statsRes.ok) {
        console.error("Failed to fetch reviews:", reviewsRes.status, statsRes.status);
        setLoading(false);
        return;
      }

      const reviewsData = await reviewsRes.json();
      const statsData = await statsRes.json();

      if (!Array.isArray(reviewsData)) {
        console.error("Invalid reviews data:", reviewsData);
        setLoading(false);
        return;
      }

      // Auto-switch to new words mode if no due reviews but there are new words
      if (mode === "review" && statsData.due === 0 && statsData.newWords > 0) {
        setMode("new");
        return;
      }

      // Try to restore queue ordering from saved positions (server-synced)
      setStats(statsData);
      const restored = initializeQueueFromPositions(reviewsData);

      if (!restored) {
        // No synced state - use API order and try legacy restore
        setReviews(reviewsData);

        // Initialize positions from API order for future sync
        const initialPositions: Record<number, number> = {};
        reviewsData.forEach((r: Review, idx: number) => {
          initialPositions[r.wordId] = idx;
        });
        writePositionState(mode, { 
          positions: initialPositions, 
          currentIndex: 0, 
          reviewedCount: 0,
          updatedAt: new Date().toISOString() 
        });

        const saved = readSavedPosition(mode);
        const savedIndex = saved
          ? reviewsData.findIndex((review: Review) => review.wordId === saved.wordId)
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
        setReviewedBeforeBatch(0);
        clearSavedPosition(mode);
        clearPositionState(mode);
        void clearServerState(mode);
      }
    } catch (error) {
      console.error("Failed to fetch reviews:", error);
    } finally {
      setLoading(false);
    }
  };

  // Load the queue once the initial sync has settled, then only again when the
  // mode actually changes. The previous polling loop could call fetchReviews
  // from its 3s timeout path *and* again when `synced` flipped to true, which
  // double-fetched /api/reviews on a slow sync.
  useEffect(() => {
    if (!synced) return;

    let cancelled = false;
    async function run() {
      if (cancelled) return;
      await fetchReviews();
    }
    void run();

    return () => {
      cancelled = true;
    };
  }, [mode, synced]);

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

  // Save per-word positions to localStorage (debounced) and sync to server.
  // Only the current queue is stored, and positions are rebased to 0..n-1, so
  // the synced payload stays bounded by the queue size instead of growing with
  // every word the user has ever seen.
  const savePositionState = useCallback(() => {
    const positions: Record<number, number> = {};
    reviews.forEach((review, idx) => {
      positions[review.wordId] = idx;
    });

    // Words already rated in this session drop out of the API queue, so resume
    // position is tracked by the reviewed count, not by an array index.
    const reviewedCount = reviewedBeforeBatch + currentIndex;

    const state: PositionState = {
      positions,
      currentIndex: 0,
      reviewedCount,
      updatedAt: new Date().toISOString(),
    };

    // Debounced localStorage write
    const existing = localStorageDebounceRef.current[mode];
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      writePositionState(mode, state);
    }, LOCAL_STORAGE_DEBOUNCE_MS);
    localStorageDebounceRef.current[mode] = timeout;

    // Server sync (already debounced via savePositionsToServer)
    // Pass current meta directly to avoid race condition with localStorage debounce
    savePositionsToServer(mode, positions, 0, reviewedCount);
  }, [mode, reviews, currentIndex, reviewedBeforeBatch, savePositionsToServer]);

  // Save when currentIndex changes (debounced via savePositionsToServer)
  useEffect(() => {
    if (loading || sessionComplete || !synced) return;
    savePositionState();
  }, [currentIndex, reviewedBeforeBatch, reviews, loading, sessionComplete, synced, savePositionState]);

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

      if (response.status === 401) {
        alert("Please log in to submit reviews.");
        return;
      }
      if (!response.ok) {
        throw new Error("Failed to submit review");
      }

      // Update stats
      setStats((prev: Stats) => {
        const next = { ...prev };
        if (mode === "review") {
          next.due = Math.max(0, (next.due || 0) - 1);
        } else {
          next.newWords = Math.max(0, (next.newWords || 0) - 1);
        }
        return next;
      });

      if (currentIndex < reviews.length - 1) {
        setCurrentIndex(currentIndex + 1);
        setShowAnswer(false);
      } else {
        setSessionComplete(true);
        setReviewedBeforeBatch(0);
        clearSavedPosition(mode);
        clearPositionState(mode);
        void clearServerState(mode);
      }
    } catch (error) {
      console.error("Review submission error:", error);
      alert("Failed to submit review. Please try again.");
    } finally {
      setPendingRating(null);
    }
  }, [reviews, currentIndex, pendingRating, mode, clearServerState]);

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
            <div className="relative inline-block px-12 text-center">
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