"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PWAInstallPrompt } from "@/components/PWAInstallPrompt";

interface NavItem {
  href: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dictionary", label: "Dictionary" },
  { href: "/review", label: "Review" },
  { href: "/review-history", label: "History" },
  { href: "/words", label: "My Words" },
];

type CurrentUser = { id: number; email: string };

interface NavBarProps {
  initialUser?: CurrentUser | null;
}

type SrsAlgorithm = "sm2" | "fsrs";

export default function NavBar({ initialUser = null }: NavBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);
  const [user, setUser] = useState<CurrentUser | null>(initialUser);
  const [algorithm, setAlgorithm] = useState<SrsAlgorithm | null>(null);

  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setMobileMenuOpen(false);
  }

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { srsAlgorithm?: SrsAlgorithm } | null) => {
        if (cancelled || !data?.srsAlgorithm) return;
        setAlgorithm(data.srsAlgorithm);
      })
      .catch(() => {
        // Toggle stays hidden when the setting cannot be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleAlgorithmChange = async (next: SrsAlgorithm) => {
    if (next === algorithm) return;
    setAlgorithm(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ srsAlgorithm: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setAlgorithm(algorithm);
    }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setAlgorithm(null);
    setMobileMenuOpen(false);
    router.push("/login");
    router.refresh();
  };

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <nav className="mx-auto max-w-4xl px-4 sm:px-6" aria-label="Main">
        <div className="flex h-14 items-center justify-between md:h-16">
          <h1 className="text-lg font-bold text-blue-600 dark:text-blue-400 md:text-xl">
            <Link
              href="/"
              className="rounded-md transition-colors hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:hover:text-blue-300 dark:focus-visible:ring-offset-gray-800"
            >
              Vocleap
            </Link>
          </h1>

          <div className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                      : "text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-300 dark:hover:bg-gray-700/60 dark:hover:text-blue-400"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}

            {user && (
              <div className="ml-2 flex items-center gap-2 border-l border-gray-200 pl-3 dark:border-gray-700">
                {algorithm && (
                  <label className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500 dark:text-gray-400">SRS</span>
                    <select
                      value={algorithm}
                      onChange={(e) => handleAlgorithmChange(e.target.value as SrsAlgorithm)}
                      aria-label="Scheduling algorithm"
                      className="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                    >
                      <option value="sm2">SM-2</option>
                      <option value="fsrs">FSRS</option>
                    </select>
                  </label>
                )}
                <span
                  className="max-w-[160px] truncate text-sm text-gray-600 dark:text-gray-300"
                  title={user.email}
                >
                  {user.email}
                </span>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="rounded-md px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-blue-600 dark:text-gray-300 dark:hover:bg-gray-700/60 dark:hover:text-blue-400"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-navigation"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-gray-700 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-700 md:hidden"
          >
            <svg
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {mobileMenuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>

        <div
          id="mobile-navigation"
          className={`grid overflow-hidden transition-all duration-300 ease-out md:hidden ${
            mobileMenuOpen
              ? "visible grid-rows-[1fr] opacity-100"
              : "invisible grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="min-h-0">
            <div className="grid grid-cols-2 gap-2 pb-4 pt-1">
              {NAV_ITEMS.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex min-h-[44px] items-center justify-center rounded-lg px-3 py-3 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                        : "bg-gray-50 text-gray-700 hover:bg-gray-100 dark:bg-gray-700/50 dark:text-gray-200 dark:hover:bg-gray-700"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}

              {user && (
                <div className="col-span-2 mt-2 border-t border-gray-200 pt-3 dark:border-gray-700">
                  {algorithm && (
                    <div className="mb-3 flex min-h-[44px] items-center justify-between gap-3">
                      <span className="text-sm text-gray-600 dark:text-gray-300">
                        Scheduling algorithm
                      </span>
                      <div
                        role="group"
                        aria-label="Scheduling algorithm"
                        className="flex rounded-lg border border-gray-200 p-0.5 dark:border-gray-600"
                      >
                        {(["sm2", "fsrs"] as const).map((algo) => (
                          <button
                            key={algo}
                            type="button"
                            onClick={() => handleAlgorithmChange(algo)}
                            aria-pressed={algorithm === algo}
                            className={`min-h-[40px] rounded-md px-3 text-sm font-medium transition-colors ${
                              algorithm === algo
                                ? "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                                : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700/60"
                            }`}
                          >
                            {algo === "sm2" ? "SM-2" : "FSRS"}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className="truncate text-sm text-gray-600 dark:text-gray-300"
                      title={user.email}
                    >
                      {user.email}
                    </span>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="flex min-h-[44px] items-center rounded-lg px-3 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      Sign out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>
      <PWAInstallPrompt />
    </header>
  );
}