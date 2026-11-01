// Sign-in and security (app-business-core issue 506; Matt Murphy steps 133 and 52):
// sign out of every device, and change the password while signed in. Reached
// from Settings. Both actions end every session of the account — see
// lib/account-security.ts for what "every" means and how fast.

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { signOutEverywhereAction } from "./actions";

export const metadata = { title: "Sign-in and security" };

export default async function AccountSecurityPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col p-4 sm:p-6">
      <header className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold text-text-primary">Sign-in and security</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Change your password, or sign out everywhere if you think someone else
          has used your account.
        </p>
      </header>

      <section className="mt-8" aria-labelledby="change-password">
        <h2 id="change-password" className="text-lg font-semibold text-text-primary">
          Change password
        </h2>
        <div className="mt-4">
          <ChangePasswordForm />
        </div>
      </section>

      <section className="mt-10" aria-labelledby="sign-out-everywhere">
        <h2 id="sign-out-everywhere" className="text-lg font-semibold text-text-primary">
          Sign out of all devices
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          Ends your session on every phone, tablet and computer, this one
          included. Other devices are signed out within 10 minutes.
        </p>
        <form action={signOutEverywhereAction} className="mt-4">
          <button
            type="submit"
            className="min-h-11 rounded border border-border px-4 py-2 font-medium text-text-primary hover:bg-surface"
          >
            Sign out of all devices
          </button>
        </form>
      </section>
    </main>
  );
}
