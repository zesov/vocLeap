import { Suspense } from "react";
import NavBar from "@/components/NavBar";
import { DictionaryLookup } from "@/components/DictionaryLookup";
import { Card, CardContent } from "@/components/ui/Card";

type DictionarySearchParams = Promise<{ word?: string | string[] }>;

async function DictionaryLookupWithParams({
  searchParams,
}: {
  searchParams: DictionarySearchParams;
}) {
  const { word } = await searchParams;
  const initialWord = Array.isArray(word) ? word[0] : word;

  return <DictionaryLookup initialWord={initialWord} />;
}

function DictionaryLookupFallback() {
  return (
    <div className="max-w-2xl mx-auto">
      <Card variant="outlined">
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div className="h-10 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800" />
            <div className="h-10 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800" />
            <div className="h-11 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function DictionaryPage({
  searchParams,
}: {
  searchParams: DictionarySearchParams;
}) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <NavBar />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <p className="text-gray-600 dark:text-gray-400 text-center mb-8">
          Look up words with Wiktionary
        </p>
        <Suspense fallback={<DictionaryLookupFallback />}>
          <DictionaryLookupWithParams searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}
