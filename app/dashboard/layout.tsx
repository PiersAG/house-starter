// Dashboard segment layout — the PRODUCT surface. Two jobs, once for every page
// under /dashboard:
//   1. The subscription paywall (step 5): a signed-in owner without an active
//      subscription (or past grace) is redirected to /reactivate before any
//      product page renders. This is the gated surface; /account, /reactivate,
//      auth and billing routes sit outside it and stay reachable while unpaid.
//   2. Renders the primary nav once, so every page under this segment inherits
//      it (it used to be imported per page and silently forgotten).
//
// Auth itself is handled upstream (edge middleware redirects an unauthenticated
// request to /login); step 5 does not touch auth. When there is no session we
// simply don't run the paywall — the middleware already owns that redirect.

import type { ReactNode } from "react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { enforcePaidPage } from "@/lib/billing/enforce";
import { AppNav } from "@/components/AppNav";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (session?.user?.id) {
    await enforcePaidPage(db, session.user.id);
  }
  return (
    <>
      <AppNav />
      {children}
    </>
  );
}
