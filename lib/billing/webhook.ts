// Stripe webhook event handling — the pure, DB-facing half of
// app/api/billing/webhook/route.ts. The route verifies the signature (I/O) and
// hands the verified event here; keeping the switch in a DI function lets it be
// unit-tested against an in-memory database with synthetic events, no signature
// or network involved (same split as instrumentation.ts's assertBootEnv).
//
// Idempotency (PiersAG/app-business-core#542, Matt Murphy #15/#37): Stripe
// delivers at-least-once, and two copies of one event can arrive together. The
// event id is CLAIMED with one insert BEFORE anything is acted on; only the
// delivery whose insert won acts, every other copy is acknowledged as a
// duplicate. If acting fails, the claim is released and the error re-thrown, so
// the route answers 500 and Stripe's retry runs the event again. A claim left
// behind by a crash (still "processing" after CLAIM_TAKEOVER_MS) is taken over
// by the next delivery, so an event is never lost to a dead claim.
//
// What a successful charge does (#788, Matt Murphy #231 — "mark the invoice paid
// activate the subscription and grant tenant access send the receipt update
// CRM"): invoice.paid records the invoice as paid in the app's own billing record
// (billing_invoices — the app's customer record, its CRM until a CRM tool is
// chosen), sets the subscription active and clears any failed-payment state —
// which is what grants access, through the paid-gate — and sends the receipt
// once.
//
// What a failed charge does (#753, Matt Murphy #136): the subscription goes
// past_due (grace window, unchanged), the invoice is recorded as failed, and one
// email of a three-email sequence goes out per Stripe payment attempt ("your
// payment failed here's how to update your card"). Stripe's own automatic
// retries do the "staggered sequence over the next 7 to 14 days"; they are an
// account setting (docs/per-app-stripe-account.md, step 6), and a failure Stripe
// will not retry is reported, because that means the setting is off.
//
// Disputes (#370): charge.dispute.created records the dispute and emails the
// app's owner with the evidence deadline and the 90-day dispute rate; later
// dispute events record its status and outcome. Access is not changed by a
// dispute (docs/billing-disputes.md).

import type Stripe from "stripe";
import { and, eq, lt } from "drizzle-orm";
import { stripeEvents } from "@/lib/schema";
import { getUserById, type AppDatabase } from "@/lib/users";
import {
  getSubscriptionByStripeCustomerId,
  updateSubscriptionByStripeCustomerId,
  upsertSubscriptionByUserId,
  type SubscriptionPatch,
} from "@/lib/billing/subscriptions";
import {
  claimDunningEmail,
  claimReceipt,
  disputeRate90d,
  forgetDispute,
  recordDisputeOpened,
  recordDisputeStatus,
  recordInvoiceFailed,
  recordInvoicePaid,
  releaseDunningEmail,
  releaseReceipt,
  type DisputeFacts,
  type InvoiceFacts,
} from "@/lib/billing/ledger";
import { sendEmail } from "@/lib/email/send";
import {
  DUNNING_EMAILS,
  disputeOpenedTemplate,
  paymentFailedTemplate,
  paymentReceiptTemplate,
} from "@/lib/email/templates/billing";

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
  id?: string | null;
  customer?: string | { id: string } | null;
  customer_email?: string | null;
  amount_paid?: number | null;
  amount_due?: number | null;
  currency?: string | null;
  attempt_count?: number | null;
  next_payment_attempt?: number | null;
  hosted_invoice_url?: string | null;
  status_transitions?: { paid_at?: number | null } | null;
}
interface Disputeish {
  id: string;
  charge?: string | { id: string } | null;
  amount?: number | null;
  currency?: string | null;
  reason?: string | null;
  status?: string | null;
  evidence_details?: { due_by?: number | null } | null;
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

/** A claim still "processing" this long after it was made is taken over. */
export const CLAIM_TAKEOVER_MS = 10 * 60_000;

export interface HandleResult {
  processed: boolean;
  duplicate?: boolean;
}

export interface HandleOptions {
  /** Injectable clock for deterministic tests. */
  now?: Date;
  /** The app's display name, used in customer emails. */
  appName?: string;
  /** The app's canonical base URL, for the "update your card" link. */
  baseUrl?: string | null;
  /** Who is told about a dispute (the app's owner). */
  ownerEmail?: string | null;
  /** Where a problem the operator must fix is reported (never throws). */
  report?: (message: string, context: Record<string, unknown>) => void | Promise<void>;
}

function defaultReport(message: string, context: Record<string, unknown>): void {
  console.error(`[billing] ${message} ${JSON.stringify(context)}`);
}

/** Whole seconds — the precision the timestamp columns store. */
function seconds(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

/** Claim `eventId` for this delivery. True when this delivery may act on it. */
async function claimEvent(db: AppDatabase, eventId: string, claimedAt: Date): Promise<boolean> {
  const won = await db
    .insert(stripeEvents)
    .values({ id: eventId, status: "processing", claimedAt, processedAt: claimedAt })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id })
    .all();
  if (won.length === 1) return true;
  const stale = new Date(claimedAt.getTime() - CLAIM_TAKEOVER_MS);
  const taken = await db
    .update(stripeEvents)
    .set({ claimedAt })
    .where(
      and(eq(stripeEvents.id, eventId), eq(stripeEvents.status, "processing"), lt(stripeEvents.claimedAt, stale)),
    )
    .returning({ id: stripeEvents.id })
    .all();
  return taken.length === 1;
}

async function finishEvent(db: AppDatabase, eventId: string, at: Date): Promise<void> {
  await db.update(stripeEvents).set({ status: "done", processedAt: at }).where(eq(stripeEvents.id, eventId)).run();
}

async function releaseEvent(db: AppDatabase, eventId: string, claimedAt: Date): Promise<void> {
  await db
    .delete(stripeEvents)
    .where(
      and(eq(stripeEvents.id, eventId), eq(stripeEvents.status, "processing"), eq(stripeEvents.claimedAt, claimedAt)),
    )
    .run();
}

/**
 * Apply a verified Stripe event to the database, exactly once per event id.
 * Returns `{ processed: false, duplicate: true }` for an event another delivery
 * has claimed or finished. Throws (after releasing its claim) when acting fails.
 */
export async function handleStripeEvent(
  db: AppDatabase,
  event: Stripe.Event,
  opts: HandleOptions = {},
): Promise<HandleResult> {
  const now = seconds(opts.now ?? new Date());
  if (!(await claimEvent(db, event.id, now))) return { processed: false, duplicate: true };
  try {
    await act(db, event, { ...opts, now });
  } catch (err) {
    await releaseEvent(db, event.id, now);
    throw err;
  }
  await finishEvent(db, event.id, now);
  return { processed: true };
}

type Ctx = HandleOptions & { now: Date };

async function act(db: AppDatabase, event: Stripe.Event, ctx: Ctx): Promise<void> {
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
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as unknown as Subscriptionish;
      const customerId = idOf(sub.customer);
      if (customerId) {
        const item = sub.items?.data?.[0];
        const newStatus =
          event.type === "customer.subscription.deleted" ? "canceled" : sub.status;
        const patch: SubscriptionPatch = {
          status: newStatus,
          stripeSubscriptionId: sub.id,
          priceId: item?.price?.id ?? null,
          currentPeriodEnd: toDate(sub.current_period_end ?? item?.current_period_end),
          trialEndsAt: toDate(sub.trial_end),
        };
        // Keep the grace anchor consistent regardless of event ordering: entering
        // past_due sets it (preserving any earlier invoice.payment_failed stamp),
        // any other status clears it so a future failure starts a fresh window.
        if (newStatus === "past_due") {
          const existing = await getSubscriptionByStripeCustomerId(db, customerId);
          patch.pastDueAt = existing?.pastDueAt ?? toDate(event.created) ?? new Date();
        } else {
          patch.pastDueAt = null;
        }
        await updateSubscriptionByStripeCustomerId(db, customerId, patch);
      }
      return;
    }
    case "invoice.paid":
      return invoicePaid(db, event, ctx);
    case "invoice.payment_failed":
      return invoiceFailed(db, event, ctx);
    case "charge.dispute.created":
      return disputeOpened(db, event, ctx);
    case "charge.dispute.updated":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated": {
      const d = event.data.object as unknown as Disputeish;
      await recordDisputeStatus(db, disputeFacts(d), ctx.now, event.type === "charge.dispute.closed");
      return;
    }
    default:
      // Unhandled event types are acknowledged (recorded) so Stripe stops
      // retrying them; the template only acts on the events above.
      return;
  }
}

async function invoiceFacts(db: AppDatabase, inv: Invoiceish): Promise<InvoiceFacts & { email: string | null }> {
  const customerId = idOf(inv.customer);
  const sub = customerId ? await getSubscriptionByStripeCustomerId(db, customerId) : undefined;
  const userId = sub?.userId ?? null;
  const email = inv.customer_email ?? (userId ? (await getUserById(db, userId))?.email ?? null : null);
  return {
    stripeInvoiceId: inv.id ?? "",
    stripeCustomerId: customerId,
    userId,
    amountPaid: inv.amount_paid ?? null,
    amountDue: inv.amount_due ?? null,
    currency: inv.currency ?? null,
    attemptCount: inv.attempt_count ?? null,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    email,
  };
}

async function invoicePaid(db: AppDatabase, event: Stripe.Event, ctx: Ctx): Promise<void> {
  const inv = event.data.object as unknown as Invoiceish;
  if (!inv.id) return;
  const { email, ...facts } = await invoiceFacts(db, inv);
  const paidAt = toDate(inv.status_transitions?.paid_at) ?? toDate(event.created) ?? ctx.now;
  await recordInvoicePaid(db, facts, paidAt);
  const amount = facts.amountPaid ?? 0;
  // A zero invoice (the start of a free trial) is recorded, but it neither
  // activates the subscription nor sends a receipt: nothing was charged.
  if (amount <= 0) return;
  if (facts.stripeCustomerId) {
    await updateSubscriptionByStripeCustomerId(db, facts.stripeCustomerId, {
      status: "active",
      pastDueAt: null,
    });
  }
  if (!email) {
    await (ctx.report ?? defaultReport)("receipt not sent: no email address for the customer", {
      invoice: facts.stripeInvoiceId,
    });
    return;
  }
  if (!(await claimReceipt(db, facts.stripeInvoiceId, ctx.now))) return;
  try {
    await sendEmail(email, paymentReceiptTemplate, {
      appName: ctx.appName ?? "App",
      amount,
      currency: facts.currency ?? "gbp",
      paidAt,
      invoiceUrl: facts.hostedInvoiceUrl,
    });
  } catch (err) {
    await releaseReceipt(db, facts.stripeInvoiceId, ctx.now);
    throw err;
  }
}

async function invoiceFailed(db: AppDatabase, event: Stripe.Event, ctx: Ctx): Promise<void> {
  const inv = event.data.object as unknown as Invoiceish;
  const customerId = idOf(inv.customer);
  if (customerId) {
    const existing = await getSubscriptionByStripeCustomerId(db, customerId);
    const patch: SubscriptionPatch = { status: "past_due" };
    // Anchor the grace window to the FIRST failure. Stripe re-fires this on
    // every dunning retry; resetting the stamp each time would extend grace
    // indefinitely. event.created is the failure time (the test-clock time
    // under a Stripe test clock); fall back to now for synthetic events.
    if (!existing?.pastDueAt) patch.pastDueAt = toDate(event.created) ?? new Date();
    await updateSubscriptionByStripeCustomerId(db, customerId, patch);
  }
  if (!inv.id) return;
  const { email, ...facts } = await invoiceFacts(db, inv);
  const failedAt = toDate(event.created) ?? ctx.now;
  await recordInvoiceFailed(db, facts, failedAt);
  const attempt = facts.attemptCount ?? 1;
  const nextAttemptAt = toDate(inv.next_payment_attempt);
  const report = ctx.report ?? defaultReport;
  if (!nextAttemptAt && attempt < DUNNING_EMAILS) {
    await report(
      "Stripe will not retry this failed payment — automatic retries look switched off in this Stripe account (docs/per-app-stripe-account.md, step 6)",
      { invoice: facts.stripeInvoiceId, attempt },
    );
  }
  if (attempt > DUNNING_EMAILS) return;
  if (!email) {
    await report("failed-payment email not sent: no email address for the customer", {
      invoice: facts.stripeInvoiceId,
    });
    return;
  }
  const step = Math.max(1, Math.min(DUNNING_EMAILS, attempt)) as 1 | 2 | 3;
  if (!(await claimDunningEmail(db, facts.stripeInvoiceId, step))) return;
  const base = ctx.baseUrl?.replace(/\/+$/, "") ?? null;
  try {
    await sendEmail(email, paymentFailedTemplate, {
      appName: ctx.appName ?? "App",
      step,
      amount: facts.amountDue ?? 0,
      currency: facts.currency ?? "gbp",
      updateCardUrl: base ? `${base}/reactivate` : (facts.hostedInvoiceUrl ?? ""),
      payNowUrl: facts.hostedInvoiceUrl,
      nextAttemptAt,
    });
  } catch (err) {
    await releaseDunningEmail(db, facts.stripeInvoiceId, step);
    throw err;
  }
}

function disputeFacts(d: Disputeish): DisputeFacts {
  return {
    stripeDisputeId: d.id,
    stripeChargeId: idOf(d.charge),
    stripeCustomerId: null,
    amount: d.amount ?? null,
    currency: d.currency ?? null,
    reason: d.reason ?? null,
    status: d.status ?? "unknown",
    evidenceDueBy: toDate(d.evidence_details?.due_by),
  };
}

async function disputeOpened(db: AppDatabase, event: Stripe.Event, ctx: Ctx): Promise<void> {
  const d = event.data.object as unknown as Disputeish;
  const facts = disputeFacts(d);
  const first = await recordDisputeOpened(db, facts, toDate(event.created) ?? ctx.now);
  if (!first) return;
  const report = ctx.report ?? defaultReport;
  if (!ctx.ownerEmail) {
    await report("a customer disputed a charge and no owner email is set to tell", {
      dispute: facts.stripeDisputeId,
      evidence_due_by: facts.evidenceDueBy?.toISOString() ?? null,
    });
    return;
  }
  const rate = await disputeRate90d(db, ctx.now);
  try {
    await sendEmail(ctx.ownerEmail, disputeOpenedTemplate, {
      appName: ctx.appName ?? "App",
      amount: facts.amount ?? 0,
      currency: facts.currency ?? "gbp",
      reason: facts.reason ?? "not given",
      evidenceDueBy: facts.evidenceDueBy,
      disputeId: facts.stripeDisputeId,
      disputes90d: rate.disputes,
      paidInvoices90d: rate.paidInvoices,
    });
  } catch (err) {
    // Forget the dispute so Stripe's retry records it again and re-sends the alert.
    await forgetDispute(db, facts.stripeDisputeId);
    throw err;
  }
}
