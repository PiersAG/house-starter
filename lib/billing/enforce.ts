// Subscription paywall wiring (capability-model retrofit step 5).
//
// The WP1 gate (lib/billing/gate.ts · requireActiveSubscription) and the gated-
// path config (config/billing.ts · isGatedPath / gatedRoutePrefixes) were built
// but had ZERO callers — nothing enforced payment past the gate. This module is
// those callers: it turns the gate's allow/deny into the actual HTTP behaviour
// at the two server surfaces, WITHOUT rebuilding the gate.
//
//   • enforcePaidApi  — for API route handlers. 402 + portal link when unpaid,
//                       driven by config/billing.ts so the gated API surface is
//                       declarative (gatedRoutePrefixes).
//   • enforcePaidPage — for gated server layouts/pages. Redirect to /reactivate
//                       when unpaid; the layout's placement IS the gated surface.
//
// subscription_billing is KERNEL (always on) — this is NOT capability off-gating.
// It is the product paywall: an unpaid owner is blocked from the product but can
// always reach auth, /account and /billing/* to pay (those surfaces never call
// this). Reuses the WP1 grace logic (getSetting grace days, past_due_at anchor)
// via requireActiveSubscription — no new policy literals here.

import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { requireActiveSubscription, stripePortalLink } from "@/lib/billing/gate";
import { isGatedPath } from "@/config/billing";
import type { AppDatabase } from "@/lib/users";

/** Where a blocked page-route request is sent to reactivate/pay. OPEN surface. */
export const REACTIVATE_PATH = "/reactivate";

export interface EnforceOptions {
  /** Injectable clock, threaded to the WP1 gate for deterministic tests. */
  now?: Date;
  /** Request origin, so the billing-portal return_url can come back here. */
  origin?: string;
}

function portalResolver(origin?: string) {
  return (customerId: string) =>
    stripePortalLink(customerId, origin ? `${origin}${REACTIVATE_PATH}` : undefined);
}

/**
 * The API paywall decision, independent of any path config: a 402 Response
 * carrying the reactivate reason + billing-portal link when the user is unpaid
 * (no subscription, or past_due beyond grace, or canceled), or null when access
 * is allowed (active | trialing | trial-not-expired | past_due-within-grace).
 * This is the WP1 reactivate response the spec calls for.
 */
export async function paidApiResponse(
  db: AppDatabase,
  userId: string,
  opts: EnforceOptions = {},
): Promise<NextResponse | null> {
  const result = await requireActiveSubscription(db, userId, {
    now: opts.now,
    portalLink: portalResolver(opts.origin),
  });
  if (result.allowed) return null;
  return NextResponse.json(
    { error: result.reason, portalUrl: result.portalUrl },
    { status: 402 },
  );
}

/**
 * Config-driven API guard for a route handler. No-op (null) when `pathname` is
 * not a gated prefix (config/billing.ts · isGatedPath) — this is what keeps auth
 * and billing/account APIs OPEN — otherwise the paywall response above. Usage:
 *
 *   const denied = await enforcePaidApi(db, userId, "/api/dogs", { origin });
 *   if (denied) return denied;
 */
export async function enforcePaidApi(
  db: AppDatabase,
  userId: string,
  pathname: string,
  opts: EnforceOptions = {},
): Promise<NextResponse | null> {
  if (!isGatedPath(pathname)) return null;
  return paidApiResponse(db, userId, opts);
}

/**
 * Page-route guard for a gated server layout. Redirects an unpaid user to the
 * OPEN /reactivate page (carrying the portal link); returns normally when
 * allowed. The gated surface is defined by WHERE this is called (the dashboard
 * segment layout), so there is no path argument.
 */
export async function enforcePaidPage(
  db: AppDatabase,
  userId: string,
  opts: EnforceOptions = {},
): Promise<void> {
  const result = await requireActiveSubscription(db, userId, { now: opts.now });
  if (!result.allowed) redirect(REACTIVATE_PATH);
}
