// The Stripe permissions this app's billing code needs, and the key check that
// keeps a full-power key out of production (PiersAG/app-business-core#544,
// Matt Murphy #235: "issue a restricted key limited to what billing needs").
//
// A Stripe SECRET key (sk_…) can do everything on the account: move money,
// refund, read every customer. The app needs two calls. So production runs on a
// RESTRICTED key (rk_…) created in the app's own Stripe account with exactly the
// permissions below and nothing else (docs/per-app-stripe-account.md, step 4).
//
// The list is held to the code by tests/unit/stripe-permissions.test.ts: every
// Stripe call in app/ and lib/ must appear here, and every row here must be in
// the doc's permission table. Adding a Stripe call without its permission fails
// the build — in production the restricted key would refuse it.
//
// Signature checks on incoming webhooks (webhooks.constructEvent) are done
// locally with the endpoint's signing secret and need no key permission.

export interface StripePermission {
  /** The SDK resource the code calls, as written after getStripe(). */
  resource: string;
  /** The method called on it. */
  call: string;
  /** The permission's name on Stripe's restricted-key page. */
  permission: string;
  /** The access level to grant: "Read" or "Write". */
  access: "Read" | "Write";
  /** Why the app needs it. */
  why: string;
}

export const STRIPE_PERMISSIONS: readonly StripePermission[] = [
  {
    resource: "checkout.sessions",
    call: "create",
    permission: "Checkout Sessions",
    access: "Write",
    why: "Start a subscription (app/api/billing/checkout/route.ts).",
  },
  {
    resource: "billingPortal.sessions",
    call: "create",
    permission: "Customer portal",
    access: "Write",
    why: "Let a customer update their card or cancel (app/api/billing/portal/route.ts, lib/billing/gate.ts).",
  },
];

export type StripeKeyKind = "restricted" | "secret" | "unknown";

/** rk_… is a restricted key; sk_… is a full-power secret key. */
export function stripeKeyKind(key: string): StripeKeyKind {
  if (/^rk_(live|test)_/.test(key)) return "restricted";
  if (/^sk_(live|test)_/.test(key)) return "secret";
  return "unknown";
}

export type KeyScopeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Production (VERCEL_ENV=production) accepts only a restricted key. Previews,
 * CI and local development run in Stripe test mode, where the factory's test
 * key is used (test data only, it cannot move real money), so they are not
 * refused. The reason never contains the key.
 */
export function checkStripeKeyScope(key: string, vercelEnv: string | undefined): KeyScopeVerdict {
  if (vercelEnv !== "production") return { ok: true };
  const kind = stripeKeyKind(key);
  if (kind === "restricted") return { ok: true };
  return {
    ok: false,
    reason:
      "lib/billing/stripe.ts: production refuses this Stripe key — it is " +
      (kind === "secret" ? "a full-power secret key (sk_…)" : "not a Stripe restricted key") +
      ". Create a restricted key (rk_…) in the app's Stripe account with only the permissions " +
      "in docs/per-app-stripe-account.md (step 4), store it as the app's billing key, and redeploy.",
  };
}
