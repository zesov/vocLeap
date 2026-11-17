import { getCurrentUser } from "@/lib/auth/session";
import { getUserAlgorithm } from "@/lib/db/operations";
import NavBar from "@/components/NavBar";
import LocalDbInit from "@/components/LocalDbInit";
import SyncStatus from "@/components/SyncStatus";

export const instant = false;

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      {user && (
        <LocalDbInit
          userId={user.id}
          email={user.email}
          srsAlgorithm={await getUserAlgorithm(user.id)}
        />
      )}
      <NavBar initialUser={user} />
      {user && <SyncStatus />}
      <main className="flex-1">{children}</main>
    </div>
  );
}
