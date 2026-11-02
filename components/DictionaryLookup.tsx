"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Card, CardContent } from "@/components/ui/Card";

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
}

export function DictionaryLookup() {
  const [word, setWord] = useState("");
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

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

  const handleTranslate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!word.trim()) return;
    
    setLoading(true);
    setError("");
    setResult(null);
    setSaveMessage("");
    
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: word.trim(), sourceLang, targetLang }),
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
  };

  const handleSave = async () => {
    if (!result) return;
    
    setSaving(true);
    setSaveMessage("");
    
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
        if (response.status === 409) {
          setSaveMessage("Word already saved!");
        } else {
          throw new Error(data.error || "Save failed");
        }
      } else {
        setSaveMessage("Word saved successfully!");
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
                    <span className="text-gray-500 dark:text-gray-400 text-lg">/{result.phonetic}/</span>
                  )}
                  {result.audioUrl && (
                    <audio controls src={result.audioUrl} className="h-8" />
                  )}
                </div>
                <p className="text-xl text-blue-600 dark:text-blue-400 font-medium">{result.translation}</p>
              </div>

              {result.definitions.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Definitions</h3>
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
                            <p key={exIndex} className="italic">"{ex}"</p>
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
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}