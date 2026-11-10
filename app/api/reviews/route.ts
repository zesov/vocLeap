import { NextRequest, NextResponse } from "next/server";
import {
  getDueReviews, getReview, createOrUpdateReview, addReviewHistory,
  getReviewStats, getReviewHistory, getReviewHistoryPage, getUserAlgorithm,
  Review, getNewWords, assertWordOwned,
} from "@/lib/db/operations";
import {
  resolveFsrsState,
  scheduleReview,
} from "@/lib/srs/schedule";
import { sm2Algorithm, parseRating } from "@/lib/srs/sm2";
import {
  previewFsrsIntervals,
  type RatingName,
} from "@/lib/srs/fsrs";
import { withUser } from "@/lib/auth/guard";
import { resolveClientTimezone } from "@/lib/timezone";
import { db } from "@/lib/db/init";

const RATING_NAMES: RatingName[] = ["again", "hard", "good", "easy"];

function ratingNameFromValue(value: unknown): RatingName | null {
  if (typeof value === "string") {
    return (RATING_NAMES as string[]).includes(value)
      ? (value as RatingName)
      : null;
  }
  if (typeof value === "number") {
    switch (value) {
      case 0: return "again";
      case 3: return "hard";
      case 4: return "good";
      case 5: return "easy";
      default: return null;
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { searchParams } = new URL(request.url);
      const action = searchParams.get("action");
      const wordId = searchParams.get("wordId");

      if (action === "due" || action === "review") {
        return NextResponse.json(
          await getDueReviews(
            user.id,
            parseInt(searchParams.get("limit") || "20", 10)
          )
        );
      }
      if (action === "new") {
        return NextResponse.json(
          await getNewWords(
            user.id,
            parseInt(searchParams.get("limit") || "20", 10)
          )
        );
      }
      if (action === "all") {
        const limit = parseInt(searchParams.get("limit") || "200", 10);
        const includeNew = searchParams.get("mode") === "new";
        // `all` keeps the same queue semantics as `review`/`new`: due words for
        // review, never-reviewed words for new. It exists so the client can
        // restore its saved ordering without loading words outside the queue.
        const queueFilter = includeNew
          ? "AND r.word_id IS NULL"
          : "AND r.word_id IS NOT NULL AND r.next_review_date <= datetime('now')";
        const stmt = db.prepare(`
          SELECT w.id AS word_id, w.word, w.translation, w.definitions, w.examples,
                 w.phonetic, w.audio_url, w.source_language, w.target_language,
                 w.created_at AS word_created_at, w.updated_at AS word_updated_at,
                 r.id AS review_id, r.ease_factor, r.interval, r.repetitions,
                 r.next_review_date, r.last_reviewed,
                 r.created_at AS review_created_at, r.updated_at AS review_updated_at
          FROM words w
          LEFT JOIN reviews r ON r.word_id = w.id
          WHERE w.user_id = ?
            ${queueFilter}
          ORDER BY ${includeNew ? "w.created_at DESC" : "r.next_review_date ASC"}
          LIMIT ?
        `);
        interface AllQueueRow {
          word_id: number;
          word: string;
          translation: string;
          definitions: string | null;
          examples: string | null;
          phonetic: string | null;
          audio_url: string | null;
          source_language: string;
          target_language: string;
          word_created_at: string | null;
          word_updated_at: string | null;
          review_id: number | null;
          ease_factor: number | null;
          interval: number | null;
          repetitions: number | null;
          next_review_date: string | null;
          last_reviewed: string | null;
          review_created_at: string | null;
          review_updated_at: string | null;
        }
        const rows = (await stmt.all(user.id, limit)) as unknown as AllQueueRow[];
        return NextResponse.json(rows.map((r) => ({
          id: r.review_id ?? 0,
          wordId: r.word_id,
          easeFactor: r.ease_factor ?? 2.5,
          interval: r.interval ?? 0,
          repetitions: r.repetitions ?? 0,
          nextReviewDate: r.next_review_date ?? new Date().toISOString(),
          lastReviewed: r.last_reviewed ?? undefined,
          createdAt: r.review_created_at ?? r.word_created_at ?? undefined,
          updatedAt: r.review_updated_at ?? r.word_updated_at ?? undefined,
          word: {
            id: r.word_id,
            word: r.word,
            translation: r.translation,
            definitions: JSON.parse(String(r.definitions || "[]")),
            examples: JSON.parse(String(r.examples || "[]")),
            phonetic: r.phonetic ?? undefined,
            audioUrl: r.audio_url ?? undefined,
            sourceLanguage: r.source_language,
            targetLanguage: r.target_language,
          },
        })));
      }
      if (action === "stats") {
        return NextResponse.json(await getReviewStats(user.id));
      }
      if (action === "history" && wordId) {
        return NextResponse.json(
          await getReviewHistory(user.id, parseInt(wordId, 10))
        );
      }
      if (action === "history") {
        const limitParam = Number.parseInt(searchParams.get("limit") || "30", 10);
        const offsetParam = Number.parseInt(searchParams.get("offset") || "0", 10);
        const limit = Math.max(
          1,
          Math.min(Number.isFinite(limitParam) ? limitParam : 30, 100)
        );
        const offset = Math.max(
          Number.isFinite(offsetParam) ? offsetParam : 0,
          0
        );
        const { entries, total } = await getReviewHistoryPage(
          user.id,
          limit,
          offset
        );

        return NextResponse.json({
          history: entries,
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        });
      }
      if (action === "intervals") {
        if (!wordId) {
          return NextResponse.json({ error: "wordId required" }, { status: 400 });
        }
        const numericId = parseInt(wordId, 10);
        if (!(await assertWordOwned(user.id, numericId))) {
          return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
        const algorithm = await getUserAlgorithm(user.id);
        const review = await getReview(user.id, numericId);
        const now = new Date();

        if (algorithm === "fsrs") {
          return NextResponse.json({
            algorithm,
            intervals: previewFsrsIntervals(resolveFsrsState(review), now),
          });
        }

        const prevSm2 = {
          easeFactor: review?.easeFactor ?? 2.5,
          interval: review?.interval ?? 0,
          repetitions: review?.repetitions ?? 0,
        };
        const intervals = Object.fromEntries(
          RATING_NAMES.map((name) => [
            name,
            sm2Algorithm({ ...prevSm2, rating: parseRating(name) }).interval,
          ])
        );
        return NextResponse.json({ algorithm, intervals });
      }
      if (wordId) {
        const review = await getReview(user.id, parseInt(wordId, 10));
        if (!review) return NextResponse.json({ error: "Not found" }, { status: 404 });
        return NextResponse.json(review);
      }
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    } catch (e) {
      console.error("GET reviews error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}

export async function POST(request: NextRequest) {
  return withUser(async (user) => {
    try {
      const { wordId, rating, timezone } = await request.json();
      if (!wordId || rating === undefined) {
        return NextResponse.json({ error: "Word ID and rating required" }, { status: 400 });
      }

      const numericWordId = Number(wordId);
      if (!(await assertWordOwned(user.id, numericWordId))) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      const ratingName = ratingNameFromValue(rating);
      if (!ratingName) {
        return NextResponse.json(
          { error: "Rating must be again|hard|good|easy or 0|3|4|5" },
          { status: 400 }
        );
      }

      // The user's device timezone decides the local-midnight boundary for
      // the next review. Invalid/absent values fall back to the legacy
      // server-local behavior so old cached clients keep working.
      const clientTimezone = resolveClientTimezone(timezone) ?? undefined;

      const review: Review | null = await getReview(user.id, numericWordId);
      const algorithm = await getUserAlgorithm(user.id);

      const scheduled = scheduleReview({
        algorithm,
        review: review
          ? {
              easeFactor: review.easeFactor,
              interval: review.interval,
              repetitions: review.repetitions,
              nextReviewDate: review.nextReviewDate,
              lastReviewed: review.lastReviewed ?? null,
              fsrsState: review.fsrsState,
            }
          : null,
        rating: ratingName,
        timezone: clientTimezone,
      });

      await createOrUpdateReview({
        wordId: numericWordId,
        ...scheduled.review,
      });
      await addReviewHistory({
        wordId: numericWordId,
        ...scheduled.history,
      });

      return NextResponse.json({
        wordId: numericWordId,
        ...scheduled.response,
      });
    } catch (e) {
      console.error("POST reviews error:", e);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  });
}
