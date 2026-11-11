import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SerwistProvider } from "@serwist/turbopack/react";
import { Analytics } from '@vercel/analytics/next';
import { SWWarmup } from "@/components/SWWarmup";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Vocleap - Learn Vocabulary with Spaced Repetition",
  description: "Look up words with Google Translate, save them, and review with SM-2 spaced repetition algorithm",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Vocleap",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#3b82f6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      </head>
      <body className="min-h-full flex flex-col bg-gray-50 dark:bg-gray-900">
        {/* reloadOnOnline stays false: Chromium fires a spurious "online"
            event (navigator.onLine is still false) in the outgoing document
            when an offline navigation swaps renderers, which would make
            SerwistProvider reload the previous page and hijack the pending
            navigation. Reconnection is handled by the sync engine instead. */}
        <SerwistProvider
          swUrl="/serwist/sw.js"
          disable={process.env.NODE_ENV === "development"}
          reloadOnOnline={false}
        >
          <SWWarmup />
          {children}
        </SerwistProvider>
      </body>
      <Analytics />
    </html>
  );
}