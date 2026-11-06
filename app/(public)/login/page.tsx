import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { safeNext } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/session";

export const instant = false;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(next);

  // Already signed in? Go straight to where they were headed.
  if (await getCurrentUser()) {
    redirect(target);
  }

  return (
    <div className="mx-auto max-w-md px-4 py-8 sm:px-6">
      <Card variant="outlined">
        <CardHeader>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">
            Sign in
          </h1>
        </CardHeader>
        <CardContent>
          <AuthForm mode="login" next={target} />
        </CardContent>
      </Card>
    </div>
  );
}