"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Card, CardContent } from "@/components/ui/Card";
import { formatPhonetic } from "@/lib/format/phonetic";

interface LookupSource {
  id: "wiktionary" | "google-translate";
  label: string;
  url?: string;
}

interface TranslationResult {
  word: string;
  translation: string;
  definitions: Array<{
    partOfSpeech: string;
    definition: string;
    examples: string[];
  }>;
  phonetic?: string;
  audioUrl?: string;
  sourceLanguage: string;
  targetLanguage: string;
  sources?: {
    definitions: LookupSource | null;
    translation: LookupSource | null;
  };
}

function SourceBadge({ source }: { source: LookupSource }) {
  const className =
    "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300";
  const content = (
    <>
      <svg
        className="h-3 w-3"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5m5.656-5.656l1.5-1.5a4 4 0 015.656 5.656l-3 3a4 4 0 01-5.656 0"
        />
      </svg>
      {source.label}
    </>
  );

  if (source.url) {
    return (
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Source: ${source.label}`}
        className={`${className} hover:text-blue-600 hover:border-blue-300 dark:hover:text-blue-400`}
      >
        {content}
      </a>
    );
  }

  return (
    <span title={`Source: ${source.label}`} className={className}>
      {content}
    </span>
  );
}

interface DictionaryLookupProps {
  initialWord?: string;
}

export function DictionaryLookup({ initialWord = "" }: DictionaryLookupProps) {
  const [word, setWord] = useState(initialWord);
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveRequiresAuth, setSaveRequiresAuth] = useState(false);

  const languageOptions = [
    { value: "en", label: "English" },
    { value: "zh-CN", label: "Chinese (Simplified)" },
    { value: "zh-TW", label: "Chinese (Traditional)" },
    { value: "ja", label: "Japanese" },
    { value: "ko", label: "Korean" },
    { value: "fr", label: "French" },
    { value: "de", label: "German" },
    { value: "es", label: "Spanish" },
    { value: "ru", label: "Russian" },
  ];

  const lookupWord = useCallback(
    async (term: string) => {
      const query = term.trim();
      if (!query) return;

      setLoading(true);
      setError("");
      setResult(null);
      setSaveMessage("");
      setSaveRequiresAuth(false);

      try {
        const response = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ word: query, sourceLang, targetLang }),
        });
        
        const data = await response.json();
        
        if (!response.ok) {
          throw new Error(data.error || "Translation failed");
        }
        
        setResult(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Translation failed");
      } finally {
        setLoading(false);
      }
    },
    [sourceLang, targetLang]
  );

  const handleTranslate = (e: React.FormEvent) => {
    e.preventDefault();
    void lookupWord(word);
  };

  const lastInitialWord = useRef("");
  useEffect(() => {
    const query = initialWord.trim();
    if (!query || lastInitialWord.current === query) return;

    lastInitialWord.current = query;
    void Promise.resolve().then(() => {
      setWord(query);
      return lookupWord(query);
    });
  }, [initialWord, lookupWord]);

  const handleSave = async () => {
    if (!result) return;
    
    setSaving(true);
    setSaveMessage("");
    setSaveRequiresAuth(false);
    
    try {
      const response = await fetch("/api/words", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          word: result.word,
          translation: result.translation,
          definitions: result.definitions.map(d => d.definition),
          examples: result.definitions.flatMap(d => d.examples),
          phonetic: result.phonetic,
          audioUrl: result.audioUrl,
          sourceLanguage: result.sourceLanguage,
          targetLanguage: result.targetLanguage,
        }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        if (response.status === 401) {
          setSaveRequiresAuth(true);
          setSaveMessage("");
        } else {
          throw new Error(data.error || "Save failed");
        }
      } else {
        setSaveMessage(response.status === 201 ? "Word saved successfully!" : "Word updated successfully!");
      }
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleSwapLanguages = () => {
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Card variant="outlined">
        <CardContent className="pt-6">
          <form onSubmit={handleTranslate} className="space-y-4">
            <div className="flex items-center gap-2">
              <Select
                value={sourceLang}
                onChange={(e) => setSourceLang(e.target.value)}
                options={languageOptions}
                className="flex-1"
              />
              <button
                type="button"
                onClick={handleSwapLanguages}
                className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                aria-label="Swap languages"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </button>
              <Select
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
                options={languageOptions}
                className="flex-1"
              />
            </div>
            
            <Input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              placeholder="Enter a word to translate..."
              label="Word"
              disabled={loading}
            />
            
            <Button type="submit" loading={loading} className="w-full" size="lg">
              Look Up
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300" role="alert">
          {error}
        </div>
      )}

      {result && (
        <Card variant="outlined">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{result.word}</h2>
                  {result.phonetic && (
                    <span className="text-gray-500 dark:text-gray-400 text-lg">
                      {formatPhonetic(result.phonetic)}
                    </span>
                  )}
                  {result.audioUrl && (
                    <audio controls src={result.audioUrl} className="h-8" />
                  )}
                </div>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <p className="text-xl text-blue-600 dark:text-blue-400 font-medium">{result.translation}</p>
                  {result.sources?.translation && (
                    <SourceBadge source={result.sources.translation} />
                  )}
                </div>
              </div>

              {result.definitions.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Definitions</h3>
                    {result.sources?.definitions && (
                      <SourceBadge source={result.sources.definitions} />
                    )}
                  </div>
                  {result.definitions.map((def, index) => (
                    <div key={index} className="space-y-2 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
                      <div className="flex items-baseline gap-2">
                        {def.partOfSpeech && (
                          <span className="text-sm text-gray-500 dark:text-gray-400 font-medium capitalize">
                            {def.partOfSpeech}
                          </span>
                        )}
                        <p className="text-gray-900 dark:text-white">{def.definition}</p>
                      </div>
                      {def.examples.length > 0 && (
                        <div className="space-y-1 pl-2 text-sm text-gray-600 dark:text-gray-300">
                          {def.examples.map((ex, exIndex) => (
                            <p key={exIndex} className="italic">{'"'}{ex}{'"'}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
                <Button onClick={handleSave} loading={saving} variant="primary">
                  Save Word
                </Button>
                <Button onClick={() => setResult(null)} variant="outline">
                  New Search
                </Button>
              </div>

              {saveMessage && (
                <p className={`text-sm ${saveMessage.includes("error") || saveMessage.includes("failed") ? "text-red-600" : "text-green-600"} dark:text-green-400`}>
                  {saveMessage}
                </p>
              )}

              {saveRequiresAuth && (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  <Link
                    href="/login?next=/dictionary"
                    className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Sign in
                  </Link>{" "}
                  to save this word.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}