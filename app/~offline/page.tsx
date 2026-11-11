import Link from "next/link";

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
        You’re offline
      </h1>
      <p className="max-w-md text-gray-600 dark:text-gray-400">
        Vocleap works offline — your saved words and reviews live on this
        device. Pages you’ve visited before are available now; reconnect
        to load anything new.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700"
      >
        Go home
      </Link>
    </main>
  );
}
