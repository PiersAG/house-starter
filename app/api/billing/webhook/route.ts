// POST /api/billing/webhook — Stripe webhook receiver.
//
// Verifies the Stripe signature against STRIPE_WEBHOOK_SECRET (using the RAW
// request body — never the parsed JSON), then hands the verified event to the
// DI handler in lib/billing/webhook.ts. The signature check is the only auth on
// this route; it must run against the exact bytes Stripe signed.
//
// Verified end-to-end via E2E, not unit tests (excluded from unit coverage like
// every app/api/** route); the handler's behaviour is unit-tested directly.

import type Stripe from "stripe";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/billing/stripe";
import { handleStripeEvent } from "@/lib/billing/webhook";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Deterministic misconfiguration — the deploy is contracted to inject this.
    return NextResponse.json(
      { error: "Billing webhook is not configured." },
      { status: 500 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header." },
      { status: 400 },
    );
  }

  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  await handleStripeEvent(db, event);
  return NextResponse.json({ received: true });
}
