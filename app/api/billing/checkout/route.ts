// POST /api/billing/checkout — start a subscription.
//
// Creates a Stripe Checkout session for the signed-in user from the app's
// configured price (config/billing.ts) and returns the hosted-checkout URL for
// the client to redirect to. Requires an authenticated session.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripe } from "@/lib/billing/stripe";
import { billingConfig } from "@/config/billing";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
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

  const checkout = await getStripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: userId,
    customer_email: session.user?.email ?? undefined,
    success_url: `${origin}/dashboard?checkout=success`,
    cancel_url: `${origin}/dashboard?checkout=cancelled`,
    ...(billingConfig.trialDays > 0
      ? { subscription_data: { trial_period_days: billingConfig.trialDays } }
      : {}),
  });

  return NextResponse.json({ url: checkout.url });
}
