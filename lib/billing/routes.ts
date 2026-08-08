// Subscription-billing route registry + inertness predicate (capability-model-
// spec §2.1 · the per-app ACTIVE switch). Client/edge-safe: imports only the two
// config-only modules — no next/server, no db, no Stripe, no settings registry —
// so it bundles into edge middleware exactly like lib/capabilities/routes.ts.
//
// WHY THIS EXISTS. `subscription_billing` is KERNEL: the surface ships in every
// app and is never deleted from the build. But whether an app SELLS a
// subscription is a per-app commission decision (Route B): a build either sets a
// price or declares "no subscription". For a build that declared none there is
// no price to charge against, so the shipped surface must be provably INERT —
// answering 404 as though it was never built — rather than live-but-misconfigured
// (the failure mode that produced the K9Coach stub-price 500: a route that was
// reachable, reached Stripe, and blew up).
//
// Toggle-safety rule: "off" means present-but-provably-inert and TESTED. Safety
// rests on the assertion in tests/unit/billing-both-states.test.ts, run in BOTH
// states by the CI `billing-matrix` job — never on absence or invisibility.
//
// Enforcement is the same two-layer shape the capability gate uses:
//   • edge middleware (middleware.ts) 404s the whole subtree before anything
//     else runs — the runtime enforcement;
//   • each handler calls requireSubscriptionBillingForPath() as defence in
//     depth, so a middleware-matcher change can never quietly re-open a route.

import { billingConfig } from "@/config/billing";
import { isKernelEnabled } from "@/config/kernel";

/**
 * Every route/API prefix the subscription-billing surface owns. A prefix gates
 * itself and everything beneath it on a segment boundary, so "/reactivate" never
 * matches "/reactivateX".
 *
 *   /api/billing  — checkout, portal and the Stripe webhook receiver.
 *   /reactivate   — the open pay-or-renew page the paywall redirects to.
 *
 * When the surface is inert these 404; the paywall that would send a user to
 * /reactivate is inert in the same state (lib/billing/enforce.ts), so nothing
 * can route a user into a 404.
 */
export const BILLING_ROUTE_PREFIXES = ["/api/billing", "/reactivate"] as const;

/**
 * Whether THIS app's subscription billing is ACTIVE. Two independent conditions,
 * both required:
 *
 *   • the kernel part is enabled (config/kernel.ts — on in every real build;
 *     false only inside a throwaway both-states CI checkout), and
 *   • the app's commission set a price rather than declaring no subscription
 *     (config/billing.ts · subscriptionActive).
 *
 * Compiled in, never read from an environment variable — a runtime billing
 * kill-switch is a rejected design (config/kernel.ts).
 */
export function isSubscriptionBillingActive(): boolean {
  return (
    isKernelEnabled("subscription_billing") &&
    billingConfig.subscriptionActive === true
  );
}

/** True when `path` is exactly `prefix` or sits beneath it on a segment
 * boundary, so "/api/billing" never matches "/api/billingX". */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/** True when `pathname` belongs to the subscription-billing surface at all,
 * irrespective of whether that surface is currently active. */
export function isBillingPath(pathname: string): boolean {
  return BILLING_ROUTE_PREFIXES.some((prefix) => underPrefix(pathname, prefix));
}

/**
 * The single predicate both the edge middleware and the per-handler guard
 * resolve through: true when `pathname` is a billing path AND this app's
 * subscription billing is inactive — i.e. the request must be answered 404.
 * A non-billing path, or an active app, returns false.
 */
export function isPathDisabledByBilling(pathname: string): boolean {
  return isBillingPath(pathname) && !isSubscriptionBillingActive();
}
