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

export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);

  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setMobileMenuOpen(false);
  }

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return;
        setUser(data?.user ?? null);
        setAuthLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setAuthLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
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

            {authLoaded && (
              <div className="ml-2 flex items-center gap-2 border-l border-gray-200 pl-3 dark:border-gray-700">
                {user ? (
                  <>
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
                  </>
                ) : (
                  <Link
                    href="/login"
                    className="rounded-md px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-blue-600 dark:text-gray-300 dark:hover:bg-gray-700/60 dark:hover:text-blue-400"
                  >
                    Sign in
                  </Link>
                )}
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

              {authLoaded && (
                <div className="col-span-2 mt-2 border-t border-gray-200 pt-3 dark:border-gray-700">
                  {user ? (
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
                  ) : (
                    <Link
                      href="/login"
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex min-h-[44px] items-center justify-center rounded-lg bg-gray-50 px-3 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:bg-gray-700/50 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      Sign in
                    </Link>
                  )}
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