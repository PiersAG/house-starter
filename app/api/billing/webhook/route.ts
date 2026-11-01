// POST /api/billing/webhook — Stripe webhook receiver.
//
// Verifies the Stripe signature against STRIPE_WEBHOOK_SECRET (using the RAW
// request body — never the parsed JSON), then hands the verified event to the
// DI handler in lib/billing/webhook.ts. The signature check is the only auth on
// this route; it must run against the exact bytes Stripe signed.
//
// A handler failure answers 500 with a fixed message (never the error's text)
// and is written to the app's error log; the handler has already released its
// claim on the event, so Stripe's retry runs it again (issue 542, issue 373).
//
// Verified end-to-end via E2E, not unit tests (excluded from unit coverage like
// every app/api/** route); the handler's behaviour is unit-tested directly.

import type Stripe from "stripe";
import { NextResponse } from "next/server";
import { catalogDb } from "@/lib/catalog";
import { getStripe } from "@/lib/billing/stripe";
import { handleStripeEvent } from "@/lib/billing/webhook";
import { requireSubscriptionBillingForPath } from "@/lib/billing/guard";
import { readSecret } from "@/lib/secrets";
import { recordError } from "@/lib/observability/error-log";
import { getAppName } from "@/lib/branding";
import { canonicalBaseUrl } from "@/lib/app-url";

export const runtime = "nodejs";

const ROUTE = "/api/billing/webhook";

export async function POST(request: Request): Promise<Response> {
  // Defence in depth behind the edge middleware. An app that sells no
  // subscription has no Stripe account sending it events; the receiver answers
  // 404 rather than the "not configured" 500 below, which would otherwise
  // advertise a webhook endpoint that exists but is broken.
  const denied = requireSubscriptionBillingForPath(new URL(request.url).pathname);
  if (denied) return denied;

  const secret = readSecret("STRIPE_WEBHOOK_SECRET");
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

  let baseUrl: string | null = null;
  try {
    baseUrl = canonicalBaseUrl(undefined, new URL(request.url).origin);
  } catch {
    // No canonical URL configured: emails fall back to Stripe's hosted invoice link.
  }

  try {
    await handleStripeEvent(catalogDb, event, {
      appName: await getAppName(),
      baseUrl,
      ownerEmail: process.env.OWNER_EMAIL?.trim() || null,
      report: async (message, context) => {
        await recordError({ message: `billing: ${message}`, route: ROUTE, method: "POST", context });
      },
    });
  } catch (err) {
    await recordError({
      message: `billing webhook failed on ${event.type}`,
      stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
      route: ROUTE,
      method: "POST",
      context: { event: event.id, type: event.type },
    });
    return NextResponse.json({ error: "Webhook handling failed; Stripe will retry." }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
