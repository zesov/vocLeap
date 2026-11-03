import NavBar from "@/components/NavBar";
import { AuthForm } from "@/components/AuthForm";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";

export default function SignupPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <NavBar />
      <div className="mx-auto max-w-md px-4 py-8 sm:px-6">
        <Card variant="outlined">
          <CardHeader>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">
              Create account
            </h1>
          </CardHeader>
          <CardContent>
            <AuthForm mode="signup" next="/review" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}