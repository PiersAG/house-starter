// Lazy Stripe client singleton for the house-starter template.
//
// Mirrors the lazy pattern of lib/db.ts: STRIPE_SECRET_KEY is read at FIRST USE,
// never at module load, so importing this module is side-effect free and neither
// the edge runtime nor the build step needs the key. A missing key throws by
// name (STRIPE_SECRET_KEY is declared deploy-injected in .env.contract).

import Stripe from "stripe";

let _stripe: Stripe | null = null;

/** Get the shared Stripe client, constructing it on first use. */
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "lib/billing/stripe.ts: STRIPE_SECRET_KEY is not set. It is declared " +
        "deploy-injected in .env.contract (source=secret) — set it and redeploy.",
    );
  }
  // apiVersion omitted deliberately: the SDK pins its own tested version, and
  // the account's default is used for any call that doesn't override it.
  _stripe = new Stripe(key);
  return _stripe;
}

/** Test hook — drop the cached client so a test can swap the env key. */
export function __resetStripeForTests(): void {
  _stripe = null;
}
