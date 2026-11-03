// POST /api/billing/portal — open the Stripe customer portal.
//
// Self-serve cancel/update: creates a billing-portal session for the signed-in
// user's Stripe customer and returns its URL. Reduces support load (a Gate B
// concern) by letting customers manage their own subscription. Requires an
// authenticated session and an existing Stripe customer for the user.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { catalogDb } from "@/lib/catalog";
import { getStripe } from "@/lib/billing/stripe";
import { getSubscriptionByUserId } from "@/lib/billing/subscriptions";
import { requireSubscriptionBillingForPath } from "@/lib/billing/guard";
import { serviceFailure } from "@/lib/observability/service-failure";
import { accessMessage, checkSensitiveAccess } from "@/lib/session/guard";
import { withRequestLog } from "@/lib/observability/with-request-log";

import { withRouteLimit } from "@/lib/abuse/route-limit";
import { sessionAccount } from "@/lib/abuse/session-account";
export const runtime = "nodejs";

async function handlePOST(request: Request): Promise<Response> {
  // Defence in depth behind the edge middleware — 404 before the session, the
  // DB read or any Stripe call when this app sells no subscription.
  const denied = requireSubscriptionBillingForPath(new URL(request.url).pathname);
  if (denied) return denied;

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "You must be signed in to manage billing." },
      { status: 401 },
    );
  }

  // Context-aware access (app-business-core issue 741): the billing portal shows
  // the account's financial records.
  const access = await checkSensitiveAccess(catalogDb, session, "billing.portal", "/dashboard");
  const refused = accessMessage(access);
  if (refused) {
    return NextResponse.json(
      { error: refused, loginPath: access.loginPath },
      { status: access.decision === "deny" ? 403 : 401 },
    );
  }

  const sub = await getSubscriptionByUserId(catalogDb, userId);
  if (!sub?.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing account found for this user." },
      { status: 404 },
    );
  }

  const origin = new URL(request.url).origin;
  let portal;
  try {
    portal = await getStripe().billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${origin}/dashboard`,
    });
  } catch (err) {
    // issue 373: a Stripe failure is a plain message plus a support reference, logged.
    return serviceFailure(err, {
      route: "/api/billing/portal",
      message: "We couldn't open your billing page. Please try again in a minute.",
    });
  }

  return NextResponse.json({ url: portal.url });
}

// One structured log line per request, with its id (issue 503).
export const POST = withRequestLog("/api/billing/portal", withRouteLimit("billing.session", handlePOST, { account: sessionAccount }));
