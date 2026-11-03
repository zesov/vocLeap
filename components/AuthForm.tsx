"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

type AuthMode = "login" | "signup";

interface AuthFormProps {
  mode: AuthMode;
  next: string;
}

const COPY = {
  login: {
    title: "Sign in",
    submit: "Sign in",
    switchText: "Need an account?",
    switchHref: "/signup",
    switchLabel: "Create one",
  },
  signup: {
    title: "Create account",
    submit: "Create account",
    switchText: "Already have an account?",
    switchHref: "/login",
    switchLabel: "Sign in",
  },
} as const;

export function AuthForm({ mode, next }: AuthFormProps) {
  const router = useRouter();
  const copy = COPY[mode];
  const switchHref = `${copy.switchHref}?next=${encodeURIComponent(next)}`;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(
          typeof data.error === "string" ? data.error : "Something went wrong"
        );
        return;
      }

      router.push(next);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />

      <Input
        label="Password"
        type="password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        helperText={mode === "signup" ? "At least 8 characters." : undefined}
        required
      />

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <Button type="submit" loading={submitting} className="w-full" size="lg">
        {copy.submit}
      </Button>

      <p className="text-center text-sm text-gray-600 dark:text-gray-400">
        {copy.switchText}{" "}
        <Link
          href={switchHref}
          className="font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          {copy.switchLabel}
        </Link>
      </p>
    </form>
  );
}