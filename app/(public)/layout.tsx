import { getCurrentUser } from "@/lib/auth/session";
import NavBar from "@/components/NavBar";

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
      <main className="flex-1">{children}</main>
    </div>
  );
}