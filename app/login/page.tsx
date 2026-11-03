import NavBar from "@/components/NavBar";
import { AuthForm } from "@/components/AuthForm";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";

function safeNext(value: string | undefined): string {
  if (!value) return "/review";
  if (!value.startsWith("/") || value.startsWith("//")) return "/review";
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(Array.isArray(next) ? next[0] : next);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <NavBar />
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
    </div>
  );
}