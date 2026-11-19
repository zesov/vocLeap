"use client";

import { Suspense } from "react";
import LocalDbInit from "@/components/LocalDbInit";
import SyncStatus from "@/components/SyncStatus";

interface PublicAuthenticatedContentProps {
  userId: number;
  email: string;
  srsAlgorithm: "sm2" | "fsrs";
  children: React.ReactNode;
}

function PublicAuthenticatedContentInner({
  userId,
  email,
  srsAlgorithm,
  children,
}: PublicAuthenticatedContentProps) {
  return (
    <LocalDbInit
      userId={userId}
      email={email}
      srsAlgorithm={srsAlgorithm}
    >
      {children}
    </LocalDbInit>
  );
}

export function PublicAuthenticatedContent({
  userId,
  email,
  srsAlgorithm,
  children,
}: PublicAuthenticatedContentProps) {
  return (
    <Suspense fallback={<AppShellSkeleton />}>
      <SyncStatus />
      <PublicAuthenticatedContentInner
        userId={userId}
        email={email}
        srsAlgorithm={srsAlgorithm}
      >
        {children}
      </PublicAuthenticatedContentInner>
    </Suspense>
  );
}

function AppShellSkeleton() {
  return (
    <main className="flex-1 w-full max-w-4xl mx-auto px-4 py-8 animate-pulse">
      <div className="space-y-6">
        <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-3/4" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="h-48 bg-gray-200 dark:bg-gray-700 rounded-xl" />
          <div className="h-48 bg-gray-200 dark:bg-gray-700 rounded-xl" />
          <div className="h-48 bg-gray-200 dark:bg-gray-700 rounded-xl" />
        </div>
      </div>
    </main>
  );
}