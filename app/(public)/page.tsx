import Link from "next/link";
import { cacheLife } from "next/cache";

async function getCurrentYear() {
  "use cache";
  cacheLife("max");
  return new Date().getFullYear();
}

export default async function HomePage() {
  const year = await getCurrentYear();
  return (
    <main className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12 flex flex-col items-center">
      <div className="text-center mb-6">
        <h2 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">Learn Vocabulary Effectively</h2>
        <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl">
          Look up any word with Wiktionary, build your personal dictionary —
          one at a time or in bulk — and commit your words to memory with
          SM-2 or FSRS spaced repetition.
        </p>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-4xl">
        <Link href="/dictionary" className="group">
          <div className="p-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-700 transition-colors h-full">
            <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center mb-4 group-hover:bg-blue-200 dark:group-hover:bg-blue-900/50 transition-colors">
              <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Dictionary</h3>
            <p className="text-gray-600 dark:text-gray-400">
              Look up words with translations, definitions, and examples from
              Wiktionary and Google Translate, then save them to your
              dictionary.
            </p>
          </div>
        </Link>
        
        <Link href="/review" className="group">
          <div className="p-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-700 transition-colors h-full">
            <div className="w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center mb-4 group-hover:bg-green-200 dark:group-hover:bg-green-900/50 transition-colors">
              <svg className="w-6 h-6 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Review</h3>
            <p className="text-gray-600 dark:text-gray-400">
              Practice at the right moment with spaced repetition — switch
              between SM-2 and FSRS anytime.
            </p>
          </div>
        </Link>
        
        <Link href="/words" className="group">
          <div className="p-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-700 transition-colors h-full">
            <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center mb-4 group-hover:bg-purple-200 dark:group-hover:bg-purple-900/50 transition-colors">
              <svg className="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">My Words</h3>
            <p className="text-gray-600 dark:text-gray-400">
              Browse and manage all your saved vocabulary words, or import
              them in bulk from a .txt, .csv, or .json file.
            </p>
          </div>
        </Link>
      </div>
      
      <div className="mt-6 text-center">
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          Works offline as a PWA • Your vocabulary syncs across devices
        </p>
      </div>

      <footer className="mt-12 w-full pt-6 border-t border-gray-200 dark:border-gray-700 text-start text-sm text-gray-500 dark:text-gray-400">
        Baked with <span className="text-red-500">♥</span> in Hong Kong © 2017-{year} Appnxt.
      </footer>
    </main>
  );
}