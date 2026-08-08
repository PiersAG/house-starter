// Subscription-billing enforcement half — server-only (capability-model-spec
// §2.1 · the per-app ACTIVE switch). Sibling of lib/capabilities/guard.ts, and
// deliberately the same shape: the client/edge-safe predicates live in
// ./routes.ts so middleware and components never pull next/server in.
//
// The sanctioned way a billing route handler makes an INACTIVE subscription
// surface inert: it answers 404, as though the route does not exist.
//
// Why 404 and not 402/403: an app that sells nothing must look like an app that
// was never built to sell. An endpoint answering 402 has confirmed it exists and
// that payment is the missing piece — that is "on, unconfigured", which is the
// exact state that produced the K9Coach stub-price 500. Absent, not forbidden.

import { NextResponse } from "next/server";
import { isPathDisabledByBilling } from "@/lib/billing/routes";

/** The 404 a billing surface returns when this app sells no subscription. */
export function billingNotFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

/**
 * Route/API guard by PATH: a 404 Response when `pathname` belongs to the
 * subscription-billing surface AND this app's subscription is inactive, else
 * null. Two callers resolve through this one predicate:
 *   • the edge middleware, which runs it on every request so the whole billing
 *     subtree is inert in one place;
 *   • each billing handler, which calls it at the top as defence in depth:
 *         const denied = requireSubscriptionBillingForPath(new URL(req.url).pathname);
 *         if (denied) return denied;
 *     so a change to the middleware matcher can never silently re-open a route
 *     that reaches Stripe.
 * A non-billing path, or an active app, returns null.
 */
export function requireSubscriptionBillingForPath(
  pathname: string,
): NextResponse | null {
  return isPathDisabledByBilling(pathname) ? billingNotFound() : null;
}
