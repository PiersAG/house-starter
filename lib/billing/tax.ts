// Sales tax / VAT at checkout (app-business-core issue 523; Matt Murphy #132: "Stripe
// Tax on at checkout with address and tax-id collection").
//
// CEO ruling 2026-11-03: VAT is OFF until the business reaches the VAT threshold, so
// config/billing.ts `automaticTax` is false in the template and in every app until
// then. Switched on, the checkout session asks Stripe Tax to work out the tax, requires
// the billing address it is worked out from, and lets a business customer give its tax
// id; the subscription the session creates keeps charging it at renewal. Switched off,
// the session carries none of these, so nothing about tax reaches Stripe.
//
// Pure: the checkout route spreads the result into its session parameters, and
// tests/unit/checkout-tax.test.ts holds both states. Setup before switching it on:
// docs/per-app-stripe-account.md § VAT and sales tax.

import type Stripe from "stripe";

export type CheckoutTaxParams = Pick<
  Stripe.Checkout.SessionCreateParams,
  "automatic_tax" | "billing_address_collection" | "tax_id_collection"
>;

export function checkoutTaxParams(automaticTax: boolean): CheckoutTaxParams {
  if (!automaticTax) return {};
  return {
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
  };
}
