// POST /api/billing/checkout — start a subscription.
//
// Creates a Stripe Checkout session for the signed-in user from the app's
// configured price (config/billing.ts) and returns the hosted-checkout URL for
// the client to redirect to. Requires an authenticated session.
//
// The refund policy (/refund-policy) is linked on the Stripe payment page, above
// the pay button, so the customer sees it before paying (issue 354, Matt Murphy
// item 138). A Stripe failure answers a plain message with a support reference and
// is written to the app's error log, never shown raw (issue 373).

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripe } from "@/lib/billing/stripe";
import { billingConfig } from "@/config/billing";
import { requireSubscriptionBillingForPath } from "@/lib/billing/guard";
import { serviceFailure } from "@/lib/observability/service-failure";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  // Defence in depth behind the edge middleware: an app whose commission
  // declared no subscription answers 404 here BEFORE the session lookup and
  // before any Stripe call, so no code path can reach checkout with the
  // template's stub price.
  const denied = requireSubscriptionBillingForPath(new URL(request.url).pathname);
  if (denied) return denied;

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "You must be signed in to subscribe." },
      { status: 401 },
    );
  }

  const priceId = billingConfig.priceIds.default;
  const origin = new URL(request.url).origin;

  // stripe-per-app-accounts: tag the session and the subscription with this
  // app's id so every Stripe object created by the app's own code is traceable
  // to its app. The customer and price carry the same app_id, set at their
  // creation in the app's own Stripe account (docs/per-app-stripe-account.md).
  const appMetadata = { app_id: billingConfig.appId };

  let checkout;
  try {
    checkout = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      customer_email: session.user?.email ?? undefined,
      metadata: appMetadata,
      success_url: `${origin}/dashboard?checkout=success`,
      cancel_url: `${origin}/dashboard?checkout=cancelled`,
      custom_text: {
        submit: { message: `Before you pay, read our refund policy: ${origin}/refund-policy` },
      },
      subscription_data: {
        metadata: appMetadata,
        ...(billingConfig.trialDays > 0
          ? { trial_period_days: billingConfig.trialDays }
          : {}),
      },
    });
  } catch (err) {
    return serviceFailure(err, {
      route: "/api/billing/checkout",
      message: "We couldn't start checkout. Please try again in a minute.",
    });
  }

  return NextResponse.json({ url: checkout.url });
}
