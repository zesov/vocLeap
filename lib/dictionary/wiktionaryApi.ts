export interface DictionaryResult {
  word: string;
  definitions: Array<{
    partOfSpeech: string;
    definition: string;
    examples: string[];
  }>;
  phonetic?: string;
  sourceLanguage?: string;
}

const META_SECTIONS = new Set([
  "alternative forms", "etymology", "pronunciation", "usage notes",
  "derived terms", "descendants", "translations", "see also", "anagrams",
  "further reading", "references", "related terms", "coordinate terms",
  "synonyms", "antonyms", "hyponyms", "hypernyms",
  // Chinese meta sections
  "發音", "詞源", "用法說明", "派生詞", "後代詞", "翻譯", "參見",
  "同義詞", "反義詞", "同源詞", "參考資料", "延伸閱讀",
  "英語發音", "韻部", "中文發音",
]);

const META_PREFIXES = ["etymology", "pronunciation", "alternative forms", "usage notes"];

const SKIP_PREFIXES = [
  "synonyms:", "coordinate terms:", "category:", "see also:", "references:",
  "further reading:", "related terms:", "antonyms:", "hyponyms:", "hypernyms:",
  "see wiktionary:", "see thesaurus:",
];

export async function lookupWord(
  word: string,
  languageCode: string = "en"
): Promise<DictionaryResult | null> {
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const normalizedWord = languageCode === "zh" ? word : word;

      const response = await fetch(
        `https://${languageCode}.wiktionary.org/w/api.php?action=query&format=json&titles=${encodeURIComponent(
          normalizedWord
        )}&prop=extracts&explaintext&section=0`,
        {
          headers: {
            "User-Agent": "Vocleap/1.0 (dictionary lookup)",
            "Accept": "application/json",
          },
        }
      );

      if (response.status === 429) {
        // Rate limited - wait and retry
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        console.error(`Wiktionary API error: ${response.status}`);
        return null;
      }

      const data = await response.json();
      return parseWiktionaryResponse(data, languageCode);
    } catch (error) {
      console.error("Wiktionary lookup error:", error);
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

interface WiktionaryQueryPage {
  title?: string;
  extract?: string;
  missing?: boolean;
}

interface WiktionaryApiResponse {
  query?: { pages?: Record<string, WiktionaryQueryPage> };
}

function parseWiktionaryResponse(
  data: WiktionaryApiResponse,
  languageCode: string
): DictionaryResult | null {
  const pages = data.query?.pages;
  if (!pages || typeof pages !== "object") {
    return null;
  }

  const pageId = Object.keys(pages)[0];
  if (!pageId || pageId === "-1" || pages[pageId].missing) {
    if (languageCode !== "zh") {
      // Fall back to the Chinese extract format once, then stop — the previous
      // code recursed with identical arguments (guaranteed stack overflow).
      return parseWiktionaryResponse(data, "zh");
    }
    return null;
  }

  const page = pages[pageId];
  const title = page.title || "";
  const extract = page.extract || "";

  if (!extract) {
    return null;
  }

  // Extract phonetic (IPA and enPR) from Wiktionary extract
  // Format examples: "IPA(key): /ˈbleɪtənt/, enPR: blā'tənt"
  const ipaMatch = extract.match(/IPA\(key\):\s*([^/]+\/[^/]+\/)/);
  const enprMatch = extract.match(/enPR:\s*([^\n,]+)/);
  const ipa = ipaMatch ? ipaMatch[1].trim() : undefined;
  const enpr = enprMatch ? enprMatch[1].trim() : undefined;

  const phonetic = ipa && enpr
    ? `英語發音：${enpr}，國際音標(幫助): ${ipa}`
    : ipa || enpr || undefined;

  const result: DictionaryResult = {
    word: title,
    definitions: [],
    phonetic,
  };

  if (languageCode === "zh") {
    result.definitions = parseChineseWiktionaryExtract(extract);
  } else {
    result.definitions = parseEnglishWiktionaryExtract(extract, title);
  }

  return result.definitions.length > 0 ? result : null;
}

function parseChineseWiktionaryExtract(extract: string): Array<{
  partOfSpeech: string;
  definition: string;
  examples: string[];
}> {
  const definitions: Array<{
    partOfSpeech: string;
    definition: string;
    examples: string[];
  }> = [];

  const lines = extract.split("\n");
  let currentSection = "詞性";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed.startsWith("==") && trimmed.endsWith("==")) {
      currentSection = trimmed.replace(/==/g, "").trim();
      continue;
    }

    if (
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("(") ||
      trimmed.startsWith("<!--")
    ) {
      continue;
    }

    const defMatch = trimmed.match(/^([^：:]+)[：:](.+)$/);
    if (defMatch) {
      const pos = defMatch[1].trim() || currentSection;
      const def = defMatch[2].trim();
      const exMatch = def.match(/\(([^)]+)\)/);
      const example = exMatch ? exMatch[1].trim() : "";
      definitions.push({
        partOfSpeech: pos || currentSection,
        definition: def,
        examples: example ? [example] : [],
      });
    } else if (trimmed.length > 5 && !trimmed.includes("===")) {
      definitions.push({
        partOfSpeech: currentSection,
        definition: trimmed,
        examples: [],
      });
    }
  }

  return definitions;
}

function parseEnglishWiktionaryExtract(
  extract: string,
  word: string
): Array<{
  partOfSpeech: string;
  definition: string;
  examples: string[];
}> {
  const definitions: Array<{
    partOfSpeech: string;
    definition: string;
    examples: string[];
  }> = [];

  const headerRegex = /^={2,}\s*([^=]+?)\s*={2,}$/gm;
  let lastIndex = 0;

  const sections: Array<{ title: string; content: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(extract)) !== null) {
    if (lastIndex > 0 && sections.length > 0) {
      const prevContent = extract.substring(lastIndex, match.index).trim();
      sections[sections.length - 1].content = prevContent;
    }
    sections.push({ title: match[1].trim(), content: "" });
    lastIndex = headerRegex.lastIndex;
  }

  if (lastIndex < extract.length && sections.length > 0) {
    sections[sections.length - 1].content = extract.substring(lastIndex).trim();
  }

  const wordLower = word.toLowerCase();

  for (const section of sections) {
    const titleLower = section.title.toLowerCase().trim();

    // Skip meta sections (exact match or prefix match, e.g. "Etymology 1")
    const isMeta = META_SECTIONS.has(titleLower) ||
      META_PREFIXES.some((p) => titleLower.startsWith(p));
    if (isMeta) {
      continue;
    }

    // Any non-meta section can contain definitions (e.g., Chinese POS like 形容詞)
    const content = section.content.trim();
    if (!content) {
      continue;
    }

    const pos = titleLower.charAt(0).toUpperCase() + titleLower.slice(1);

    const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

    for (const para of paragraphs) {
      const lines = para.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

      for (const line of lines) {
        const lowerLine = line.toLowerCase();

        if (lowerLine === wordLower) {
          continue;
        }

        if (SKIP_PREFIXES.some((prefix) => lowerLine.startsWith(prefix))) {
          continue;
        }

        const cleaned = line
          .replace(/^["\u201c\u201d']+|["\u201c\u201d']+$/g, "")
          .replace(/[\u2018\u2019]/g, "'")
          .replace(/\s+/g, " ")
          .trim();

        if (!cleaned) {
          continue;
        }

        const exampleMatch = cleaned.match(/\(([^)]{3,})\)/);
        const example = exampleMatch ? exampleMatch[1].trim() : "";

        const definition = exampleMatch
          ? cleaned.replace(/\([^)]{3,}\)/, "").trim()
          : cleaned;

        if (!definition) {
          continue;
        }

        definitions.push({
          partOfSpeech: pos,
          definition: definition,
          examples: example ? [example] : [],
        });
      }
    }
  }

  if (definitions.length === 0) {
    const fallbackLines = extract.split("\n").filter((l) => {
      const t = l.trim();
      return (
        t.length > 10 &&
        !t.startsWith("=") &&
        !t.startsWith("#") &&
        !t.startsWith("*") &&
        t.toLowerCase() !== wordLower &&
        !SKIP_PREFIXES.some((p) => t.toLowerCase().startsWith(p))
      );
    });
    for (const line of fallbackLines.slice(0, 3)) {
      definitions.push({
        partOfSpeech: "未知",
        definition: line.trim().replace(/\s+/g, " "),
        examples: [],
      });
    }
  }

  return definitions;
}

export async function lookupMultipleLanguages(
  word: string,
  languageCodes: string[] = ["en", "zh"]
): Promise<Record<string, DictionaryResult | null>> {
  const results: Record<string, DictionaryResult | null> = {};

  for (const langCode of languageCodes) {
    results[langCode] = await lookupWord(word, langCode);
  }

  return results;
}