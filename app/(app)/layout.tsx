import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserAlgorithm } from "@/lib/db/operations";
import NavBar from "@/components/NavBar";
import { AuthenticatedContent } from "./authenticated-content";

export const instant = false;

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  const srsAlgorithm = await getUserAlgorithm(user.id);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <NavBar initialUser={user} />
      <AuthenticatedContent
        userId={user.id}
        email={user.email}
        srsAlgorithm={srsAlgorithm}
      >
        {children}
      </AuthenticatedContent>
    </div>
  );
}
