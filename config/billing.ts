// Per-app billing configuration — the ONLY billing file a per-app build phase
// edits. Everything in lib/billing/** and app/api/billing/** is generic
// template code that reads from here.
//
// A per-app build:
//   1. Creates its products/prices in its own Stripe account.
//   2. Replaces the stub price id(s) below with the real ones.
//   3. Sets trialDays and the route prefixes that require an active
//      subscription.
//
// …OR, for an app whose commission declared NO SUBSCRIPTION, it sets
// `subscriptionActive: false` and creates nothing in Stripe (see that field).
//
// The template ships a STUB price id so template CI (which never talks to
// Stripe) stays truthful — the shape is exercised, no real charge is possible.

export interface BillingConfig {
  /**
   * Stripe price IDs the checkout route may subscribe a customer to. `default`
   * is the price used when checkout is called without an explicit plan; apps
   * with multiple tiers add more named entries.
   */
  priceIds: Record<string, string>;
  /**
   * This app's id (stripe-per-app-accounts). Written onto the metadata of the
   * Stripe objects the app's own code creates — the checkout session and the
   * subscription — as `app_id`, so a Stripe object can be traced to its app.
   * The per-app build phase sets this. See docs/per-app-stripe-account.md; the
   * customer and price carry the same `app_id`, set at their (dashboard/script)
   * creation time in the app's OWN Stripe account.
   */
  appId: string;
  /**
   * Optional statement descriptor for this app (5–22 chars). With per-app
   * Stripe ACCOUNTS the account's own name is what shows on Checkout, receipts
   * and the card statement — so this is normally left null and the account
   * setting governs. Kept here for the price/product statement_descriptor set
   * at creation, and for documentation of the app's intended descriptor.
   */
  statementDescriptor: string | null;
  /** Free-trial length in days. 0 = no trial (card required up front). */
  trialDays: number;
  /**
   * Route prefixes that require an active subscription (or live trial). The
   * gate helper matches a request path against these; empty = nothing gated
   * yet (the template default). Example: ["/app", "/api/reports"].
   *
   * NOTE: an empty array is NOT a signal that billing is dormant. This file
   * configures SUBSCRIPTION BILLING — the owner→factory subscription, which is
   * KERNEL and always on (config/kernel.ts, flag `subscription_billing`). It is
   * NOT governed by the `payments` capability flag: `payments` is client
   * payments (client→owner), a separate, not-yet-built capability. This array
   * only ever decides which paths the paid-gate covers.
   */
  gatedRoutePrefixes: string[];
  /**
   * Whether THIS app sells a subscription. The per-app ACTIVE switch for the
   * `subscription_billing` kernel part (capability-model-spec §2.1).
   *
   * BUILT-IN vs ACTIVE — the distinction this field exists to carry:
   *   • BUILT IN is kernel and invariant: every app ships the subscription
   *     surface (config/kernel.ts · `subscription_billing`, permanently on).
   *     Nothing here removes code from the build.
   *   • ACTIVE is per-app and is a COMMISSION decision (Route B): a build
   *     either sets a subscription price OR declares "no subscription". A
   *     personal tool or a disposable build declares no subscription, and the
   *     scaffold sets this to false instead of inventing a price.
   *
   * true  (template default) — the billing surface is live and priceIds.default
   *       must be a real Stripe price; the fail-closed CI guard
   *       (scripts/check-billing-configured.mjs) enforces that.
   * false — the billing surface is INERT: every path in BILLING_ROUTE_PREFIXES
   *       (lib/billing/routes.ts) answers 404 at the edge AND in its own
   *       handler, the paywall never engages, and no code path reaches Stripe.
   *       The stub price id STAYS in place — an inactive app must NOT carry a
   *       real or invented price, and the same CI guard enforces that too.
   *
   * OFF is a TESTED state, never an assumed one: tests/unit/billing-both-states
   * .test.ts asserts the inert behaviour, and the CI `billing-matrix` job runs
   * the suite with this field flipped BOTH ways.
   */
  subscriptionActive: boolean;
}

export const billingConfig: BillingConfig = {
  priceIds: {
    // STUB — replace with the app's real Stripe price id at build time.
    default: "price_stub_replace_me",
  },
  // STUB — the per-app build phase replaces this with the app's id (e.g. its
  // slug), tagged onto Stripe objects as `app_id`.
  appId: "app_stub_replace_me",
  // Normally null: the per-app Stripe account's own name governs the descriptor.
  statementDescriptor: null,
  trialDays: 14,
  gatedRoutePrefixes: [],
  // DEFAULT ON. The scaffold flips this to false only for a build whose
  // commission explicitly declared "no subscription"
  // (agents/build/provision_stripe_price.py · stamp_subscription_inactive).
  subscriptionActive: true,
};

/**
 * True when `path` falls under a gated route prefix from the config. Matches on
 * a path-segment boundary so "/apple" does not match a "/app" prefix.
 */
export function isGatedPath(path: string): boolean {
  return billingConfig.gatedRoutePrefixes.some(
    (prefix) => path === prefix || path.startsWith(prefix + "/"),
  );
}
