"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { SortSelect } from "@/components/ui/SortSelect";
import { formatPhonetic } from "@/lib/format/phonetic";

const ITEMS_PER_PAGE = 30;

type SortOption = "date_desc" | "date_asc" | "alpha_asc" | "alpha_desc";

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "alpha_asc", label: "A–Z" },
  { value: "alpha_desc", label: "Z–A" },
];

function isSortOption(value: unknown): value is SortOption {
  return (
    typeof value === "string" &&
    SORT_OPTIONS.some((option) => option.value === value)
  );
}

export default function WordsPage() {
  const [words, setWords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [sort, setSort] = useState<SortOption>("date_desc");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; failed: number; total: number; message: string } | null>(null);
  const observerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchWords = useCallback(
    async (
      nextOffset: number = 0,
      append: boolean = false,
      nextSort: SortOption = "date_desc"
    ) => {
      if (append) {
        setLoadingMore(true);
      }

      try {
        const res = await fetch(
          `/api/words?limit=${ITEMS_PER_PAGE}&offset=${nextOffset}&sort=${nextSort}`
        );
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }

        const data = await res.json();
        setWords((prev) => (append ? [...prev, ...data.words] : data.words));
        setHasMore(data.hasMore);
        setOffset(data.offset + data.words.length);
        setSort(isSortOption(data.sort) ? data.sort : nextSort);
        setError(null);
      } catch (err) {
        console.error("Fetch words error:", err);
        setError(err instanceof Error ? err.message : "Failed to load words");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    // The first page is fetched after the effect runs; state updates happen
    // once the response resolves, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchWords(0, false, "date_desc");
  }, [fetchWords]);

  const handleLoadMore = useCallback(() => {
    if (hasMore && !loadingMore && !loading) {
      fetchWords(offset, true, sort);
    }
  }, [hasMore, loadingMore, loading, offset, sort, fetchWords]);

  const handleSortChange = (nextSort: SortOption) => {
    setSort(nextSort);
    setWords([]);
    setOffset(0);
    setHasMore(true);
    setError(null);
    setLoading(true);
    fetchWords(0, false, nextSort);
  };

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

  const parseImportText = (text: string): Array<{ word: string; translation: string }> => {
    const trimmed = text.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((e: any) => e && e.word && e.translation)
          .map((e: any) => ({ word: String(e.word).trim(), translation: String(e.translation).trim() }));
      }
    } catch {
    }

    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const tabParts = line.split("\t");
        if (tabParts.length === 2 && tabParts[0].trim() && tabParts[1].trim()) {
          return { word: tabParts[0].trim(), translation: tabParts[1].trim() };
        }

        const parts = line.split(",");
        if (parts.length === 2) {
          let word = parts[0].trim().replace(/^"(.*)"$/, "$1");
          let translation = parts[1].trim().replace(/^"(.*)"$/, "$1");
          const lowerWord = word.toLowerCase();
          const lowerTranslation = translation.toLowerCase();
          const headerWords = ["word", "translation", "term", "english", "chinese", "中文", "英文", "source", "target"];
          if (headerWords.includes(lowerWord) || headerWords.includes(lowerTranslation)) {
            return null;
          }
          if (word && translation) {
            return { word, translation };
          }
        } else if (parts.length === 4) {
          let word = parts[2].trim().replace(/^"(.*)"$/, "$1");
          let translation = parts[3].trim().replace(/^"(.*)"$/, "$1");
          const lowerWord = word.toLowerCase();
          const lowerTranslation = translation.toLowerCase();
          const headerWords = ["word", "translation", "term", "english", "chinese", "中文", "英文", "source", "target"];
          if (headerWords.includes(lowerWord) || headerWords.includes(lowerTranslation)) {
            return null;
          }
          if (word && translation) {
            return { word, translation };
          }
        }

        const colonIndex = line.indexOf(":");
        if (colonIndex > 0) {
          const word = line.slice(0, colonIndex).trim();
          const translation = line.slice(colonIndex + 1).trim();
          if (word && translation) {
            return { word, translation };
          }
        }

        const spaceIndex = line.indexOf(" ");
        if (spaceIndex > 0) {
          const word = line.slice(0, spaceIndex).trim();
          const translation = line.slice(spaceIndex + 1).trim();
          if (word && translation) {
            return { word, translation };
          }
        }

        return null;
      })
      .filter((e): e is { word: string; translation: string } => e !== null);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedTypes = ["text/plain", "application/json", "text/csv", "application/csv"];
    if (!allowedTypes.includes(file.type) && !file.name.match(/\.(txt|json|csv)$/i)) {
      setImportResult({
        imported: 0,
        failed: 0,
        total: 0,
        message: "Unsupported file type. Please use .txt, .json, or .csv",
      });
      return;
    }

    setImporting(true);
    setImportResult(null);

    try {
      const text = await file.text();
      const entries = parseImportText(text);

      if (entries.length === 0) {
        setImportResult({ imported: 0, failed: 0, total: 0, message: "No valid entries found in file" });
        setImporting(false);
        return;
      }

      const res = await fetch("/api/words", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entries),
      });

      const result = await res.json();

      if (result.imported > 0) {
        setOffset(0);
        await fetchWords(0, false, sort);
      }

      setImportResult({
        imported: result.imported,
        failed: result.failed,
        total: result.total,
        message: `Imported ${result.imported} of ${result.total} words from ${file.name}${result.failed > 0 ? ` (${result.failed} failed)` : ""}`,
      });
    } catch (err) {
      setImportResult({
        imported: 0,
        failed: 0,
        total: 0,
        message: err instanceof Error ? err.message : "File import failed",
      });
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">My Words</h1>
          <p className="text-gray-600 dark:text-gray-400">Your saved vocabulary</p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            onClick={handleImportClick}
            disabled={importing}
            className="w-full sm:w-auto"
          >
            {importing ? "Importing..." : "Import Words"}
          </Button>

          <div className="w-full sm:w-44">
            <SortSelect
              label="Sort words"
              value={sort}
              options={SORT_OPTIONS}
              onChange={handleSortChange}
            />
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.json,.csv"
            onChange={handleFileImport}
            className="sr-only"
          />
        </div>

        {error && (
          <Card variant="destructive" className="w-full mt-4">
            <CardContent className="p-4">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </CardContent>
          </Card>
        )}

        {importResult && (
          <Card variant={importResult.failed > 0 && importResult.imported === 0 ? "destructive" : "default"} className="w-full mt-4">
            <CardContent className="p-4">
              <p className={`text-sm ${
                importResult.failed > 0 && importResult.imported === 0
                  ? "text-red-600 dark:text-red-400"
                  : importResult.imported > 0
                  ? "text-green-600 dark:text-green-400"
                  : "text-gray-600 dark:text-gray-400"
              }`}>
                {importResult.message}
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : words.length === 0 ? (
        <Card variant="outlined">
          <CardContent className="py-12 text-center">
            <p className="text-gray-500 dark:text-gray-400">No words saved yet. Look up words in the dictionary or import from Google Translate above!</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {words.map((word: any) => (
              <Card key={word.id} variant="outlined" className="hover:border-blue-300 transition-colors">
                <CardContent className="pt-6">
                  <h3 className="text-xl font-bold text-gray-900 dark:text-white">{word.word}</h3>
                  {word.phonetic && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {formatPhonetic(word.phonetic)}
                    </p>
                  )}
                  <p className="text-blue-600 dark:text-blue-400 font-medium">{word.translation}</p>
                  {word.definitions && word.definitions.length > 0 && (
                    <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">{word.definitions.slice(0, 2).join(", ")}</p>
                  )}
                  <p className="text-xs text-gray-400 mt-3">Saved: {new Date(word.created_at || word.createdAt).toLocaleDateString()}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          
          {hasMore && (
            <div className="flex justify-center py-8">
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 bg-blue-600 rounded-full animate-pulse" />
                <span className="text-sm text-gray-600 dark:text-gray-400">Loading more words...</span>
              </div>
            </div>
          )}
          <div ref={observerRef} className="h-1" />
        </>
      )}
    </div>
  );
}