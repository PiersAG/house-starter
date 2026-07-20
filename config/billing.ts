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
// The template ships a STUB price id so template CI (which never talks to
// Stripe) stays truthful — the shape is exercised, no real charge is possible.

export interface BillingConfig {
  /**
   * Stripe price IDs the checkout route may subscribe a customer to. `default`
   * is the price used when checkout is called without an explicit plan; apps
   * with multiple tiers add more named entries.
   */
  priceIds: Record<string, string>;
  /** Free-trial length in days. 0 = no trial (card required up front). */
  trialDays: number;
  /**
   * Route prefixes that require an active subscription (or live trial). The
   * gate helper matches a request path against these; empty = nothing gated
   * yet (the template default). Example: ["/app", "/api/reports"].
   *
   * NOTE: an empty array is NOT a signal that billing is dormant. Whether the
   * billing capability is active is governed solely by the `payments` flag in
   * config/capabilities.ts (billing-gap-fill-spec §WP1.2). This array only ever
   * decides which paths the paid-gate covers.
   */
  gatedRoutePrefixes: string[];
}

export const billingConfig: BillingConfig = {
  priceIds: {
    // STUB — replace with the app's real Stripe price id at build time.
    default: "price_stub_replace_me",
  },
  trialDays: 14,
  gatedRoutePrefixes: [],
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
