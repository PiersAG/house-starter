// The paid-gate: the active-subscription-or-trial check that gated API routes
// and server components call. Returns an allow/deny result rather than throwing,
// so callers can turn a deny into the exact HTTP 402 the Phase 4 acceptance test
// observes ("expired trial + no active subscription → HTTP 402 on gated routes").
//
// This is DELIBERATELY NOT edge middleware. lib/auth.ts is Node-only and the
// codebase keeps DB reads out of the per-request edge path (renewal-time
// revocation checks in lib/revoked-sessions.ts). The gate reads the DB, so it
// runs at the API/server-component layer.

import { getSubscriptionByUserId } from "@/lib/billing/subscriptions";
import type { AppDatabase } from "@/lib/users";

/** Stripe statuses that grant access. */
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export interface GateAllow {
  allowed: true;
}
export interface GateDeny {
  allowed: false;
  /** HTTP status a route should return — Payment Required. */
  status: 402;
  reason: string;
}
export type GateResult = GateAllow | GateDeny;

/**
 * Allow when the user has an active/trialing subscription, OR a trial that has
 * not yet expired (`trialEndsAt` in the future). Otherwise deny with 402.
 *
 * `now` is injectable for deterministic tests; production passes the default.
 */
export async function requireActiveSubscription(
  db: AppDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<GateResult> {
  const sub = await getSubscriptionByUserId(db, userId);

  if (sub && ACTIVE_STATUSES.has(sub.status)) {
    return { allowed: true };
  }
  if (sub?.trialEndsAt && sub.trialEndsAt.getTime() > now.getTime()) {
    return { allowed: true };
  }

  return {
    allowed: false,
    status: 402,
    reason: sub
      ? "Your subscription is not active. Please renew to continue."
      : "This feature requires an active subscription.",
  };
}
