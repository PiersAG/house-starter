// /reactivate — the OPEN billing surface an unpaid owner is sent to (step 5).
//
// The dashboard paywall (app/dashboard/layout.tsx) redirects here when a signed-
// in owner has no active subscription (or is past the failed-payment grace
// window). It sits OUTSIDE /dashboard so it is never itself paywalled, and it
// carries the way to pay: subscribe (Stripe Checkout) or manage an existing
// subscription (Stripe billing portal). Requires a session — an unauthenticated
// visitor is sent to /login (auth is upstream; step 5 does not touch it).

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ReactivateActions } from "@/app/reactivate/ReactivateActions";

export const metadata = { title: "Reactivate your subscription" };

export default async function ReactivatePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col p-4 sm:p-6">
      <header className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold text-text-primary">
          Reactivate your subscription
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          Your subscription isn’t active, so the dashboard is paused. Start or
          renew your subscription to get back in — your data is safe and waiting.
        </p>
      </header>

      <ReactivateActions />

      <p className="mt-8 text-sm text-text-secondary">
        Need to update account preferences instead?{" "}
        <a href="/account" className="font-medium text-primary hover:underline">
          Go to your account
        </a>
        .
      </p>
    </main>
  );
}
