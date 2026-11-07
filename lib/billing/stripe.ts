// Lazy Stripe client singleton for the house-starter template.
//
// Mirrors the lazy pattern of lib/db.ts: STRIPE_SECRET_KEY is read at FIRST USE,
// never at module load, so importing this module is side-effect free and neither
// the edge runtime nor the build step needs the key. A missing key throws by
// name (STRIPE_SECRET_KEY is declared deploy-injected in .env.contract).
//
// In production the key must be a RESTRICTED key (rk_…) holding only the
// permissions in lib/billing/permissions.ts; a full-power secret key is refused
// with a plain reason (PiersAG/app-business-core#544).

import Stripe from "stripe";
import { readSecret } from "@/lib/secrets";
import { checkStripeKeyScope } from "@/lib/billing/permissions";
import { checkPlaceholderPrice } from "@/lib/billing/placeholder";
import { billingConfig } from "@/config/billing";

let _stripe: Stripe | null = null;

/** Get the shared Stripe client, constructing it on first use. */
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = readSecret("STRIPE_SECRET_KEY");
  if (!key) {
    throw new Error(
      "lib/billing/stripe.ts: STRIPE_SECRET_KEY is not set. It is declared " +
        "deploy-injected in .env.contract (source=secret) — set it and redeploy.",
    );
  }
  const scope = checkStripeKeyScope(key, process.env.VERCEL_ENV);
  if (!scope.ok) throw new Error(scope.reason);
  // A placeholder price never reaches a live price (issue 374).
  const price = checkPlaceholderPrice(key, billingConfig.pricePlaceholder);
  if (!price.ok) throw new Error(price.reason);
  // apiVersion omitted deliberately: the SDK pins its own tested version, and
  // the account's default is used for any call that doesn't override it.
  _stripe = new Stripe(key);
  return _stripe;
}

/** Test hook — drop the cached client so a test can swap the env key. */
export function __resetStripeForTests(): void {
  _stripe = null;
}
