import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { AppNav } from "@/components/AppNav";

export const metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const session = await auth();
  // Middleware already guards /dashboard; this is defence in depth so the page
  // never renders for an unauthenticated request.
  if (!session?.user) {
    redirect("/login");
  }

  const displayName = session.user.name ?? session.user.email ?? "there";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col p-4 sm:p-6">
      <header className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-xl font-semibold text-text-primary">Your notes</h1>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button
            type="submit"
            className="min-h-11 rounded border border-border px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Sign out
          </button>
        </form>
      </header>

      <AppNav />

      <section className="mt-6" aria-label="Account">
        <p className="text-text-secondary">
          Signed in as{" "}
          <span className="font-medium text-text-primary">{displayName}</span>.
        </p>
      </section>

    </main>
  );
}
