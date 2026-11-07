// The placeholder-price guard (app-business-core #374, CEO ruling 2026-11-03).
//
// With no price in the brief, the build uses a £20/month placeholder, clearly marked
// as one: provisioning stamps `pricePlaceholder: true` into config/billing.ts. The
// build is never blocked for want of a price, and test mode works as usual — but a
// placeholder must never reach a live price. So a live Stripe key (sk_live_… or
// rk_live_…) is refused while the flag is set; the real price is set first
// (app-business-core scripts/set_app_price.py, then the live price at the live
// switch-over, #469). The launch checklist refuses a placeholder too.

import type { KeyScopeVerdict } from "@/lib/billing/permissions";

/** True for a live-mode Stripe key. Test keys cannot move real money. */
export function isLiveStripeKey(key: string): boolean {
  return /^(sk|rk)_live_/.test(key);
}

/** Refuses a live key while the price is the placeholder. The reason never contains the key. */
export function checkPlaceholderPrice(key: string, pricePlaceholder: boolean): KeyScopeVerdict {
  if (!pricePlaceholder || !isLiveStripeKey(key)) return { ok: true };
  return {
    ok: false,
    reason:
      "lib/billing/stripe.ts: this app's price is the build's £20/month PLACEHOLDER " +
      "(config/billing.ts pricePlaceholder: true), so a live Stripe key is refused. Set the " +
      "real price before taking real payments (app-business-core scripts/set_app_price.py; " +
      "the live price is created at the live switch-over, #469), then redeploy.",
  };
}
