// Stripe webhook event handling — the pure, DB-facing half of
// app/api/billing/webhook/route.ts. The route verifies the signature (I/O) and
// hands the verified event here; keeping the switch in a DI function lets it be
// unit-tested against an in-memory database with synthetic events, no signature
// or network involved (same split as instrumentation.ts's assertBootEnv).
//
// Idempotency: Stripe delivers at-least-once. Every handled event id is recorded
// in stripe_events; an event whose id is already present is skipped, so a
// redelivery never double-applies.

import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { stripeEvents } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";
import {
  updateSubscriptionByStripeCustomerId,
  upsertSubscriptionByUserId,
} from "@/lib/billing/subscriptions";

// Minimal shapes for the fields we read. Deliberately NOT Stripe's full types:
// optional fields like current_period_end move between API versions, and a
// narrow local shape keeps this handler compiling across SDK minor bumps.
interface CheckoutSessionish {
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
}
interface Subscriptionish {
  id: string;
  status: string;
  customer: string | { id: string };
  current_period_end?: number | null;
  trial_end?: number | null;
  items?: { data?: Array<{ price?: { id?: string } | null; current_period_end?: number | null }> };
}
interface Invoiceish {
  customer?: string | { id: string } | null;
}

/** Resolve a Stripe id that may arrive as a bare string or an expanded object. */
function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/** Seconds-since-epoch (Stripe's unit) → Date, or null. */
function toDate(epochSeconds: number | null | undefined): Date | null {
  return typeof epochSeconds === "number" ? new Date(epochSeconds * 1000) : null;
}

export interface HandleResult {
  processed: boolean;
  duplicate?: boolean;
}

/**
 * Apply a verified Stripe event to the database, idempotently. Returns
 * `{ processed: false, duplicate: true }` for an event id already handled.
 */
export async function handleStripeEvent(
  db: AppDatabase,
  event: Stripe.Event,
): Promise<HandleResult> {
  const seen = await db
    .select()
    .from(stripeEvents)
    .where(eq(stripeEvents.id, event.id))
    .limit(1)
    .all();
  if (seen[0]) return { processed: false, duplicate: true };

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as unknown as CheckoutSessionish;
      const userId = s.client_reference_id ?? s.metadata?.userId ?? null;
      if (userId) {
        await upsertSubscriptionByUserId(db, {
          userId,
          status: "active",
          stripeCustomerId: idOf(s.customer),
          stripeSubscriptionId: idOf(s.subscription),
        });
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as unknown as Subscriptionish;
      const customerId = idOf(sub.customer);
      if (customerId) {
        const item = sub.items?.data?.[0];
        await updateSubscriptionByStripeCustomerId(db, customerId, {
          status: event.type === "customer.subscription.deleted" ? "canceled" : sub.status,
          stripeSubscriptionId: sub.id,
          priceId: item?.price?.id ?? null,
          currentPeriodEnd: toDate(sub.current_period_end ?? item?.current_period_end),
          trialEndsAt: toDate(sub.trial_end),
        });
      }
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as unknown as Invoiceish;
      const customerId = idOf(inv.customer);
      if (customerId) {
        await updateSubscriptionByStripeCustomerId(db, customerId, { status: "past_due" });
      }
      break;
    }
    default:
      // Unhandled event types are acknowledged (recorded) so Stripe stops
      // retrying them; the template only acts on the lifecycle events above.
      break;
  }

  await db.insert(stripeEvents).values({ id: event.id }).run();
  return { processed: true };
}
