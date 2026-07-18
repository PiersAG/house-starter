// POST /api/billing/portal — open the Stripe customer portal.
//
// Self-serve cancel/update: creates a billing-portal session for the signed-in
// user's Stripe customer and returns its URL. Reduces support load (a Gate B
// concern) by letting customers manage their own subscription. Requires an
// authenticated session and an existing Stripe customer for the user.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/billing/stripe";
import { getSubscriptionByUserId } from "@/lib/billing/subscriptions";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "You must be signed in to manage billing." },
      { status: 401 },
    );
  }

  const sub = await getSubscriptionByUserId(db, userId);
  if (!sub?.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing account found for this user." },
      { status: 404 },
    );
  }

  const origin = new URL(request.url).origin;
  const portal = await getStripe().billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${origin}/dashboard`,
  });

  return NextResponse.json({ url: portal.url });
}
