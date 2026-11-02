import { NextRequest, NextResponse } from "next/server";
import {
  getDueReviews, getReview, createOrUpdateReview, addReviewHistory,
  getReviewStats, getReviewHistory, getAllReviewHistory, Review, getNewWords,
} from "@/lib/db/operations";
import { sm2Algorithm, parseRating, getInitialSM2State, formatDateForDB } from "@/lib/srs/sm2";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const wordId = searchParams.get("wordId");

    if (action === "due" || action === "review") {
      return NextResponse.json(
        await getDueReviews(parseInt(searchParams.get("limit") || "20", 10))
      );
    }
    if (action === "new") {
      return NextResponse.json(
        await getNewWords(parseInt(searchParams.get("limit") || "20", 10))
      );
    }
    if (action === "stats") {
      return NextResponse.json(await getReviewStats());
    }
    if (action === "history" && wordId) {
      return NextResponse.json(await getReviewHistory(parseInt(wordId, 10)));
    }
    if (action === "history") {
      return NextResponse.json(await getAllReviewHistory());
    }
    if (wordId) {
      const review = await getReview(parseInt(wordId, 10));
      if (!review) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(review);
    }
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (e) {
    console.error("GET reviews error:", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { wordId, rating } = await request.json();
    if (!wordId || rating === undefined) {
      return NextResponse.json({ error: "Word ID and rating required" }, { status: 400 });
    }

    const numericRating = typeof rating === "string" ? parseRating(rating as "again" | "hard" | "good" | "easy") : rating;
    if (numericRating < 0 || numericRating > 5) {
      return NextResponse.json({ error: "Rating must be 0-5" }, { status: 400 });
    }

    const review: Review | null = await getReview(wordId);
    const prevState = review ? {
      easeFactor: review.easeFactor,
      interval: review.interval,
      repetitions: review.repetitions,
    } : { easeFactor: 2.5, interval: 0, repetitions: 0 };

    const inputReview = review || {
      id: 0, wordId, easeFactor: 2.5, interval: 0, repetitions: 0,
      nextReviewDate: new Date().toISOString(), lastReviewed: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    const result = sm2Algorithm({
      easeFactor: inputReview.easeFactor,
      interval: inputReview.interval,
      repetitions: inputReview.repetitions,
      rating: numericRating,
    });

    await createOrUpdateReview({
      wordId,
      easeFactor: result.easeFactor,
      interval: result.interval,
      repetitions: result.repetitions,
      nextReviewDate: formatDateForDB(result.nextReviewDate),
      lastReviewed: formatDateForDB(new Date()),
    });

    await addReviewHistory({
      wordId,
      rating: numericRating,
      previousEaseFactor: prevState.easeFactor,
      previousInterval: prevState.interval,
      previousRepetitions: prevState.repetitions,
      newEaseFactor: result.easeFactor,
      newInterval: result.interval,
      newRepetitions: result.repetitions,
    });

    return NextResponse.json({
      wordId,
      easeFactor: result.easeFactor,
      interval: result.interval,
      repetitions: result.repetitions,
      nextReviewDate: formatDateForDB(result.nextReviewDate),
    });
  } catch (e) {
    console.error("POST reviews error:", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}