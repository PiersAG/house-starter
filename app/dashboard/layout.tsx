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
import { catalogDb } from "@/lib/catalog";
import { enforcePaidPage } from "@/lib/billing/enforce";
import { AppNav } from "@/components/AppNav";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (session?.user?.id) {
    await enforcePaidPage(catalogDb, session.user.id);
  }
  // `@container/page` makes this segment a container context, so any component
  // rendered under /dashboard can size itself against the space the PAGE gives
  // it rather than against the window (card 2.3.15, docs/responsive.md). It is
  // a context only — it sets no width and changes no layout, so nothing that
  // already renders here moves.
  // The nav's narrow arrangement is a FIXED bottom tab bar (card 2.3.49), which
  // is out of flow and would otherwise sit on top of the last few lines of every
  // page. `pb-24` gives the content something to scroll past; at `roomy` the bar
  // returns to the top of the page in normal flow and the padding goes away.
  //
  // The boundary name here MUST match the one AppNav switches on — both are
  // `roomy`. A test asserts it: if they drifted, either the bar would cover
  // content or a desktop page would carry dead space at the bottom.
  return (
    <div className="@container/page">
      <AppNav />
      <div className="pb-24 @roomy/page:pb-0">{children}</div>
    </div>
  );
}
