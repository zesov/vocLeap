"use client";

import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const subscribeNoop = () => () => {};

function detectIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

type InstallHint = "ios" | "desktop" | null;

export function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  // Only ever set from a timer or an event handler. Scheduling this during
  // render can update a component that never mounted.
  const [hint, setHint] = useState<InstallHint>(null);
  // False on the server/hydration pass, true once hydrated on the client.
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  const handleDismiss = useCallback((target: Exclude<InstallHint, null>) => {
    setHint(null);
    localStorage.setItem(
      target === "ios" ? "pwa-ios-hint-dismissed" : "pwa-desktop-hint-dismissed",
      "true"
    );
  }, []);

  const handlePromptDismiss = useCallback(() => {
    setDeferredPrompt(null);
    localStorage.setItem("pwa-install-dismissed", "true");
  }, []);

  useEffect(() => {
    // Listen for beforeinstallprompt (Android/Chrome/Edge)
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      // A real prompt supersedes the fallback hints.
      setHint(null);
      localStorage.setItem("pwa-desktop-hint-dismissed", "true");
    };
    window.addEventListener("beforeinstallprompt", handler);

    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  // Detect the install state and schedule the fallback hints. All of this is a
  // side effect: doing it during render schedules a state update for a
  // component that may never mount.
  useEffect(() => {
    if (!mounted) return;

    // Standalone means the app is already installed: nothing to show.
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    if (detectIOS()) {
      if (localStorage.getItem("pwa-ios-hint-dismissed")) return;
      const timer = setTimeout(() => setHint("ios"), 3000);
      return () => clearTimeout(timer);
    }

    // The install button (beforeinstallprompt) is shown ahead of the hint.
    if (deferredPrompt) return;
    if (/Android|iPhone|iPad|iPod|Mobile/.test(navigator.userAgent)) return;
    if (localStorage.getItem("pwa-desktop-hint-dismissed")) return;
    // Show after 10s to avoid competing with page content.
    const timer = setTimeout(() => setHint("desktop"), 10000);
    return () => clearTimeout(timer);
  }, [mounted, deferredPrompt]);

  if (!mounted) return null;

  // iOS: show hint once (unless dismissed)
  if (hint === "ios") {
    return (
      <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:bottom-4 md:w-80 z-50 animate-slide-up">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45.22-2.003.659-.55.44-.897 1.07-.897 1.752V18" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                Install Vocleap to Home Screen
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Tap the share icon <svg className="inline w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
                and choose {'"'}Add to Home Screen{'"'}
              </p>
            </div>
            <button
              onClick={() => handleDismiss("ios")}
              className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              aria-label="Dismiss"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Android/Chrome/Edge: show install button if beforeinstallprompt fired
  if (deferredPrompt) {
    return (
      <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:bottom-4 md:w-72 z-50 animate-slide-up">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45.22-2.003.659-.55.44-.897 1.07-.897 1.752V18" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                安裝 Vocleap
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                離線使用，更快啟動，像原生 App 一樣
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handlePromptDismiss}>
                稍後
              </Button>
              <Button size="sm" onClick={handleInstall} className="w-auto">
                安裝
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Desktop fallback: show hint after delay if app appears installable but no prompt fired
  // Check if we're on a desktop browser that supports PWA (Chrome/Edge)
  if (hint === "desktop") {
    return (
      <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:bottom-4 md:w-80 z-50 animate-slide-up">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45.22-2.003.659-.55.44-.897 1.07-.897 1.752V18" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                Install as Desktop App
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Click the install icon in the address bar <svg className="inline w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                or menu {'"'}Install Vocleap...{'"'}
              </p>
            </div>
            <button
              onClick={() => handleDismiss("desktop")}
              className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              aria-label="Dismiss"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}