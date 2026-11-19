import { getCurrentUser } from "@/lib/auth/session";
import { getUserAlgorithm } from "@/lib/db/operations";
import NavBar from "@/components/NavBar";
import { PublicAuthenticatedContent } from "./authenticated-content";

export const instant = false;

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <NavBar initialUser={user} />
      {user && (
        <PublicAuthenticatedContent
          userId={user.id}
          email={user.email}
          srsAlgorithm={await getUserAlgorithm(user.id)}
        >
          {children}
        </PublicAuthenticatedContent>
      )}
      {!user && <main className="flex-1">{children}</main>}
    </div>
  );
}
