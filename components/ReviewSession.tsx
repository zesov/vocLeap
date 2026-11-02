"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";
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

export function ReviewSession() {
  const [mode, setMode] = useState<Mode>("review");
  const [reviews, setReviews] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [stats, setStats] = useState<any>({ due: 0, total: 0, newWords: 0 });
  const [loading, setLoading] = useState(true);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [pendingRating, setPendingRating] = useState<Rating | null>(null);

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
        // Don't set sessionComplete here - let the useEffect re-fetch with mode="new"
        return;
      }
      
      setReviews(reviewsData);
      setStats(statsData);
      setCurrentIndex(0);
      setShowAnswer(false);
      setSessionComplete(reviewsData.length === 0);
    } catch (error) {
      console.error("Failed to fetch reviews:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReviews();
  }, [mode]);

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

      const ratedDueReview = mode === "review";
      if (ratedDueReview) {
        setStats((prev: { due: number; total: number; newWords: number }) => ({ ...prev, due: Math.max(0, prev.due - 1) }));
      }
      
      if (currentIndex < reviews.length - 1) {
        setCurrentIndex(currentIndex + 1);
        setShowAnswer(false);
      } else {
        setSessionComplete(true);
      }
    } catch (error) {
      console.error("Review submission error:", error);
      alert("Failed to submit review. Please try again.");
    } finally {
      setPendingRating(null);
    }
  }, [reviews, currentIndex, pendingRating, mode]);

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
                : `You reviewed ${reviews.length} word${reviews.length > 1 ? "s" : ""}.`}
            </p>
            <div className="mt-6 flex gap-4 justify-center">
              <Button onClick={() => setMode(mode === "review" ? "new" : "review")} variant="outline">
                Switch to {mode === "review" ? "New Words" : "Review"}
              </Button>
              <Button onClick={fetchReviews} variant="outline">
                Check Again
              </Button>
              <Button onClick={() => window.location.href = "/dictionary"}>
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

  const progress = reviews.length > 0 ? ((currentIndex + 1) / reviews.length) * 100 : 0;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400 mb-2">
        <span>Card {currentIndex + 1} of {reviews.length}</span>
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
              {mode === "review" ? "Review" : "New Word"} {currentIndex + 1} of {reviews.length}
            </span>
            {currentReview?.word?.phonetic && (
              <span className="text-gray-500 dark:text-gray-400 text-sm">
                /{currentReview.word.phonetic}/
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="text-center">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
              {currentReview?.word?.word || "Word"}
            </h1>
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