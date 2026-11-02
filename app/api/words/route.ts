import { NextRequest, NextResponse } from "next/server";
import {
  createWord,
  getWordById,
  getWordByText,
  getAllWords,
  updateWord,
  deleteWord,
  Word,
  createOrUpdateReview,
} from "@/lib/db/operations";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const word = searchParams.get("word");
    
    if (id) {
      const w = await getWordById(parseInt(id, 10));
      if (!w) {
        return NextResponse.json({ error: "Word not found" }, { status: 404 });
      }
      return NextResponse.json(w);
    }
    
    if (word) {
      const w = await getWordByText(word);
      if (!w) {
        return NextResponse.json({ error: "Word not found" }, { status: 404 });
      }
      return NextResponse.json(w);
    }
    
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = parseInt(searchParams.get("offset") || "0");
    const { words, total } = await getAllWords(limit, offset);
    
    return NextResponse.json({
      words,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    console.error("Get words error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Batch import: array of word entries
    if (Array.isArray(body)) {
      const results: Array<{ word: string; success: boolean; id?: number; error?: string }> = [];

      for (const entry of body) {
        const { word, translation, definitions, examples, phonetic, audioUrl, sourceLanguage, targetLanguage } = entry;

        if (!word || !translation) {
          results.push({ word: word || "", success: false, error: "Word and translation are required" });
          continue;
        }

        const existing = await getWordByText(word);
        if (existing) {
          results.push({ word, success: false, error: "Word already exists", id: existing.id });
          continue;
        }

        const wordData: Omit<Word, "id" | "createdAt" | "updatedAt"> = {
          word: word.trim(),
          translation,
          definitions: definitions || [],
          examples: examples || [],
          phonetic: phonetic || "",
          audioUrl: audioUrl || "",
          sourceLanguage: sourceLanguage || "en",
          targetLanguage: targetLanguage || "zh-CN",
        };

        try {
          const id = await createWord(wordData);
          const newWord = await getWordById(id);
          if (!newWord) {
            throw new Error("Created word could not be loaded");
          }
          
          // Create review entry so word appears in review page immediately
          await createOrUpdateReview({
            wordId: id,
            easeFactor: 2.5,
            interval: 0,
            repetitions: 0,
            nextReviewDate: new Date().toISOString().split('T')[0],
          });
          
          results.push({ word, success: true, id: newWord.id });
        } catch (err) {
          results.push({ word, success: false, error: err instanceof Error ? err.message : "Failed to create word" });
        }
      }

      const imported = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      return NextResponse.json({
        imported,
        failed,
        total: results.length,
        results,
      }, { status: 201 });
    }

    // Single word import (existing behavior)
    const { word, translation, definitions, examples, phonetic, audioUrl, sourceLanguage, targetLanguage } = body;

    if (!word || !translation) {
      return NextResponse.json(
        { error: "Word and translation are required" },
        { status: 400 }
      );
    }

    const existing = await getWordByText(word);
    if (existing) {
      return NextResponse.json(
        { error: "Word already exists", word: existing },
        { status: 409 }
      );
    }

    const wordData: Omit<Word, "id" | "createdAt" | "updatedAt"> = {
      word: word.trim(),
      translation,
      definitions: definitions || [],
      examples: examples || [],
      phonetic: phonetic || "",
      audioUrl: audioUrl || "",
      sourceLanguage: sourceLanguage || "en",
      targetLanguage: targetLanguage || "zh-CN",
    };

    const id = await createWord(wordData);
    const newWord = await getWordById(id);

    // Create review entry so word appears in review page immediately
    await createOrUpdateReview({
      wordId: id,
      easeFactor: 2.5,
      interval: 0,
      repetitions: 0,
      nextReviewDate: new Date().toISOString().split('T')[0],
    });

    return NextResponse.json(newWord, { status: 201 });
  } catch (error) {
    console.error("Create word error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, ...updates } = body;
    
    if (!id) {
      return NextResponse.json(
        { error: "Word ID is required" },
        { status: 400 }
      );
    }
    
    const success = await updateWord(id, updates);
    if (!success) {
      return NextResponse.json({ error: "Word not found" }, { status: 404 });
    }
    
    const updated = await getWordById(id);
    return NextResponse.json(updated);
  } catch (error) {
    console.error("Update word error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    
    if (!id) {
      return NextResponse.json(
        { error: "Word ID is required" },
        { status: 400 }
      );
    }
    
    const success = await deleteWord(parseInt(id, 10));
    if (!success) {
      return NextResponse.json({ error: "Word not found" }, { status: 404 });
    }
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete word error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}