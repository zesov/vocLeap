import { NextRequest, NextResponse } from "next/server";
import {
  lookupWord,
} from "@/lib/dictionary/wiktionaryApi";

const LANG_TO_WIKT_CODE: Record<string, string> = {
  "en": "en",
  "zh-CN": "zh",
  "zh-TW": "zh",
  "ja": "ja",
  "ko": "ko",
  "fr": "fr",
  "de": "de",
  "es": "es",
  "ru": "ru",
};

const LANG_TO_ISO2: Record<string, string> = {
  "en": "en",
  "zh-CN": "zh",
  "zh-TW": "zh",
  "ja": "ja",
  "ko": "ko",
  "fr": "fr",
  "de": "de",
  "es": "es",
  "ru": "ru",
};

async function fetchWiktionaryExtract(
  languageCode: string,
  word: string,
  maxRetries: number = 3
): Promise<string | null> {
  const baseDelay = 1000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(
        `https://${languageCode}.wiktionary.org/w/api.php?action=query&format=json&titles=${encodeURIComponent(
          word
        )}&prop=extracts&explaintext&section=0`,
        {
          headers: {
            "User-Agent": "Vocleap/1.0 (dictionary lookup)",
            "Accept": "application/json",
          },
        }
      );

      if (response.status === 429) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const pages = data.query?.pages;
      if (!pages || typeof pages !== "object") return null;

      const pageId = Object.keys(pages)[0];
      if (!pageId || pageId === "-1" || pages[pageId].missing) return null;

      const page = pages[pageId];
      return page.extract || null;
    } catch (err) {
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return null;
    }
  }

  return null;
}

function extractCJKTranslation(extract: string): string {
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\ac00-\ud7af]/;
  const lines = extract.split("\n");
  const translations: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("=") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
    if (trimmed.length < 2 || trimmed.length > 30) continue;
    if (!cjkRegex.test(trimmed)) continue;
    if (trimmed.includes("國際音標") || trimmed.includes("發音") || trimmed.includes("詞源")) continue;
    if (/[\u4e00-\u9fff][：:]\s*[^\u4e00-\u9fff]/.test(trimmed)) continue;
    if (!/^[\u4e00-\u9fff]/.test(trimmed)) continue;
    translations.push(trimmed);
  }

  return translations.join("、");
}

export async function POST(request: NextRequest) {
  try {
    const { word, sourceLang, targetLang } = await request.json();

    if (!word || typeof word !== "string") {
      return NextResponse.json(
        { error: "Word is required" },
        { status: 400 }
      );
    }

    const sourceCode = LANG_TO_WIKT_CODE[sourceLang || "en"] || "en";
    const targetCode = LANG_TO_WIKT_CODE[targetLang || "zh-CN"] || "en";

    const dictResult = await lookupWord(word.trim(), sourceCode);

    if (!dictResult) {
      // Fallback to anylang translator when Wiktionary has no result
      try {
        const { GoogleTranslator } = await import("anylang/esm/translators/GoogleTranslator");
        const translator = new GoogleTranslator();
        const isoSource = LANG_TO_ISO2[sourceLang || "en"] || "en";
        const isoTarget = LANG_TO_ISO2[targetLang || "zh-CN"] || "en";
        const translation = await translator.translate(word.trim(), isoSource, isoTarget);

        return NextResponse.json({
          word: word.trim(),
          translation,
          definitions: [],
          phonetic: undefined,
          sourceLanguage: sourceLang || "en",
          targetLanguage: targetLang || "zh-CN",
        });
      } catch (err) {
        console.error("AnyLang fallback error:", err);
        return NextResponse.json(
          { error: "Word not found" },
          { status: 404 }
        );
      }
    }

    const definitions = (dictResult.definitions || [])
      .slice(0, 5)
      .map((d) => ({
        partOfSpeech: d.partOfSpeech,
        definition: d.definition,
        examples: d.examples || [],
      }));

    let translation = "";
    if (targetCode !== sourceCode) {
      try {
        const extract = await fetchWiktionaryExtract(targetCode, word.trim());
        if (extract) {
          translation = extractCJKTranslation(extract);
        }
      } catch (err) {
        console.error("Target Wiktionary fetch error:", err);
      }
    } else if (definitions[0]) {
      translation = definitions[0].definition;
    }

    const result = {
      word: dictResult.word,
      translation,
      definitions,
      phonetic: dictResult.phonetic || undefined,
      sourceLanguage: sourceLang || "en",
      targetLanguage: targetLang || "zh-CN",
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error("Translate route error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}