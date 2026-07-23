// The paid-gate: the active-subscription-or-trial check that gated API routes
// and server components call. Returns an allow/deny result rather than throwing,
// so callers can turn a deny into the exact HTTP 402 the Phase 4 acceptance test
// observes ("expired trial + no active subscription → HTTP 402 on gated routes").
//
// This is DELIBERATELY NOT edge middleware. lib/auth.ts is Node-only and the
// codebase keeps DB reads out of the per-request edge path (renewal-time
// revocation checks in lib/revoked-sessions.ts). The gate reads the DB, so it
// runs at the API/server-component layer.
//
// Grace window (billing-gap-fill-spec §WP1.1): a subscription that has gone
// past_due keeps access for `billing.subscription_grace_days` after it first
// went past_due — read through the settings resolver, never a literal here. Past
// the boundary the deny carries a Stripe billing-portal link so the user can fix
// payment. The portal link is resolved through an injected function so the gate
// stays a pure DB unit (no Stripe call in tests).

import { getSubscriptionByUserId } from "@/lib/billing/subscriptions";
import { hasLiveGrant } from "@/lib/billing/grants";
import { getSetting } from "@/lib/settings/resolver";
import type { AppDatabase } from "@/lib/users";

/** Stripe statuses that grant access outright. */
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

/** Registry key for the failed-payment grace window (days). */
const GRACE_DAYS_KEY = "billing.subscription_grace_days";

const DAY_MS = 86_400_000;

export interface GateAllow {
  allowed: true;
}
export interface GateDeny {
  allowed: false;
  /** HTTP status a route should return — Payment Required. */
  status: 402;
  reason: string;
  /**
   * Stripe billing-portal link to fix payment, when there is a Stripe customer
   * to manage and a resolver was supplied. Null otherwise (e.g. no subscription
   * at all, or the gate was called without a portal resolver).
   */
  portalUrl: string | null;
}
export type GateResult = GateAllow | GateDeny;

/** Resolves a Stripe billing-portal URL for a customer. Injected for testability. */
export type PortalLinkResolver = (stripeCustomerId: string) => Promise<string | null>;

export interface GateOptions {
  /** Injectable clock for deterministic tests; production passes the default. */
  now?: Date;
  /**
   * Supplies the billing-portal link embedded in a 402 deny. Omit and the deny
   * carries `portalUrl: null` — the gate never calls Stripe itself.
   */
  portalLink?: PortalLinkResolver;
}

/**
 * Allow when the user has an active/trialing subscription, a trial that has not
 * yet expired, OR a past_due subscription still inside its grace window. Any
 * other state denies with 402, carrying a portal link where one can be resolved.
 */
export async function requireActiveSubscription(
  db: AppDatabase,
  userId: string,
  opts: GateOptions = {},
): Promise<GateResult> {
  const now = opts.now ?? new Date();
  const sub = await getSubscriptionByUserId(db, userId);

  if (sub && ACTIVE_STATUSES.has(sub.status)) {
    return { allowed: true };
  }
  if (sub?.trialEndsAt && sub.trialEndsAt.getTime() > now.getTime()) {
    return { allowed: true };
  }

  // Grace window: a past_due subscription keeps access for a registry-configured
  // number of days measured from when it first went past_due. The anchor is the
  // webhook-stamped pastDueAt; updatedAt is a defensive fallback for a legacy row
  // that predates the column.
  if (sub?.status === "past_due") {
    const graceDays = await getSetting<number>(db, GRACE_DAYS_KEY);
    const anchor = sub.pastDueAt ?? sub.updatedAt;
    const boundary = anchor.getTime() + graceDays * DAY_MS;
    if (now.getTime() < boundary) {
      return { allowed: true };
    }
  }

  // Access grant (owner-account-paywall-exemption): a LIVE grant allows access
  // exactly as an active subscription does — the single audited exemption path.
  // An expired grant falls through to the 402 below, same as a lapsed sub.
  if (await hasLiveGrant(db, userId, now)) {
    return { allowed: true };
  }

  const portalUrl =
    sub?.stripeCustomerId && opts.portalLink
      ? await opts.portalLink(sub.stripeCustomerId)
      : null;

  return {
    allowed: false,
    status: 402,
    reason: sub
      ? "Your subscription payment is overdue. Please update your payment method to continue."
      : "This feature requires an active subscription.",
    portalUrl,
  };
}

/**
 * Default production portal-link resolver: creates a Stripe billing-portal
 * session for the customer and returns its URL. Kept out of the gate module's
 * pure path — callers that want a real link pass this (or a wrapper that adds a
 * return_url) as `opts.portalLink`. Imported lazily so the gate module has no
 * static Stripe dependency and stays edge-import-safe.
 */
export async function stripePortalLink(
  stripeCustomerId: string,
  returnUrl?: string,
): Promise<string | null> {
  const { getStripe } = await import("@/lib/billing/stripe");
  const session = await getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    ...(returnUrl ? { return_url: returnUrl } : {}),
  });
  return session.url ?? null;
}
