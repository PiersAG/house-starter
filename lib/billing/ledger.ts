// The app's own billing record (bundle S13, PiersAG/app-business-core): one row
// per Stripe invoice (#788, #753) and per card dispute (#370). Written only by
// the webhook handler (lib/billing/webhook.ts); DI on the database like
// lib/billing/subscriptions.ts so it is unit-tested against an in-memory DB.
//
// Each "send once" step is a single conditional UPDATE … RETURNING, so two
// deliveries racing for the same email cannot both win it.

import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { billingDisputes, billingInvoices, type BillingInvoice } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";

export interface InvoiceFacts {
  stripeInvoiceId: string;
  stripeCustomerId: string | null;
  userId: string | null;
  amountPaid: number | null;
  amountDue: number | null;
  currency: string | null;
  attemptCount: number | null;
  hostedInvoiceUrl: string | null;
}

/** Record that an invoice was paid. Returns the stored row. */
export async function recordInvoicePaid(
  db: AppDatabase,
  facts: InvoiceFacts,
  paidAt: Date,
): Promise<BillingInvoice> {
  const values = { ...facts, status: "paid", paidAt, updatedAt: paidAt };
  const rows = await db
    .insert(billingInvoices)
    .values(values)
    .onConflictDoUpdate({
      target: billingInvoices.stripeInvoiceId,
      set: {
        status: "paid",
        paidAt,
        amountPaid: facts.amountPaid,
        attemptCount: facts.attemptCount,
        hostedInvoiceUrl: facts.hostedInvoiceUrl,
        userId: sql`coalesce(${billingInvoices.userId}, ${facts.userId})`,
        updatedAt: paidAt,
      },
    })
    .returning()
    .all();
  return rows[0];
}

/** Record that a payment attempt on an invoice failed. Returns the stored row. */
export async function recordInvoiceFailed(
  db: AppDatabase,
  facts: InvoiceFacts,
  failedAt: Date,
): Promise<BillingInvoice> {
  const rows = await db
    .insert(billingInvoices)
    .values({ ...facts, status: "payment_failed", lastFailedAt: failedAt, updatedAt: failedAt })
    .onConflictDoUpdate({
      target: billingInvoices.stripeInvoiceId,
      set: {
        // A late "failed" for an invoice already paid never un-pays it.
        status: sql`case when ${billingInvoices.status} = 'paid' then 'paid' else 'payment_failed' end`,
        lastFailedAt: failedAt,
        amountDue: facts.amountDue,
        attemptCount: facts.attemptCount,
        hostedInvoiceUrl: facts.hostedInvoiceUrl,
        userId: sql`coalesce(${billingInvoices.userId}, ${facts.userId})`,
        updatedAt: failedAt,
      },
    })
    .returning()
    .all();
  return rows[0];
}

/** Claim the receipt for an invoice. True for exactly one caller. */
export async function claimReceipt(db: AppDatabase, invoiceId: string, at: Date): Promise<boolean> {
  const won = await db
    .update(billingInvoices)
    .set({ receiptSentAt: at })
    .where(and(eq(billingInvoices.stripeInvoiceId, invoiceId), isNull(billingInvoices.receiptSentAt)))
    .returning({ id: billingInvoices.stripeInvoiceId })
    .all();
  return won.length === 1;
}

/** Undo claimReceipt when the email could not be sent, so a retry sends it. */
export async function releaseReceipt(db: AppDatabase, invoiceId: string, at: Date): Promise<void> {
  await db
    .update(billingInvoices)
    .set({ receiptSentAt: null })
    .where(and(eq(billingInvoices.stripeInvoiceId, invoiceId), eq(billingInvoices.receiptSentAt, at)))
    .run();
}

/**
 * Claim failed-payment email number `step` (1, 2 or 3) for an invoice. True for
 * exactly one caller, and only when no later email of the sequence went out.
 */
export async function claimDunningEmail(
  db: AppDatabase,
  invoiceId: string,
  step: number,
): Promise<boolean> {
  const won = await db
    .update(billingInvoices)
    .set({ dunningEmailsSent: step })
    .where(and(eq(billingInvoices.stripeInvoiceId, invoiceId), lt(billingInvoices.dunningEmailsSent, step)))
    .returning({ id: billingInvoices.stripeInvoiceId })
    .all();
  return won.length === 1;
}

/** Undo claimDunningEmail when the email could not be sent. */
export async function releaseDunningEmail(db: AppDatabase, invoiceId: string, step: number): Promise<void> {
  await db
    .update(billingInvoices)
    .set({ dunningEmailsSent: step - 1 })
    .where(and(eq(billingInvoices.stripeInvoiceId, invoiceId), eq(billingInvoices.dunningEmailsSent, step)))
    .run();
}

export interface DisputeFacts {
  stripeDisputeId: string;
  stripeChargeId: string | null;
  stripeCustomerId: string | null;
  amount: number | null;
  currency: string | null;
  reason: string | null;
  status: string;
  evidenceDueBy: Date | null;
}

/** Record a dispute that opened. Returns true the first time it is seen. */
export async function recordDisputeOpened(db: AppDatabase, facts: DisputeFacts, at: Date): Promise<boolean> {
  const rows = await db
    .insert(billingDisputes)
    .values({ ...facts, openedAt: at, updatedAt: at })
    .onConflictDoNothing()
    .returning({ id: billingDisputes.stripeDisputeId })
    .all();
  return rows.length === 1;
}

/** Remove a just-recorded dispute whose owner alert could not be sent. */
export async function forgetDispute(db: AppDatabase, disputeId: string): Promise<void> {
  await db.delete(billingDisputes).where(eq(billingDisputes.stripeDisputeId, disputeId)).run();
}

/** Record a dispute's new status; `closed` stamps when it was decided. */
export async function recordDisputeStatus(
  db: AppDatabase,
  facts: DisputeFacts,
  at: Date,
  closed: boolean,
): Promise<void> {
  await db
    .insert(billingDisputes)
    .values({ ...facts, openedAt: at, updatedAt: at, closedAt: closed ? at : null })
    .onConflictDoUpdate({
      target: billingDisputes.stripeDisputeId,
      set: { status: facts.status, updatedAt: at, ...(closed ? { closedAt: at } : {}) },
    })
    .run();
}

/** Disputes opened, and invoices paid, in the 90 days up to `now`. */
export async function disputeRate90d(
  db: AppDatabase,
  now: Date,
): Promise<{ disputes: number; paidInvoices: number }> {
  const since = new Date(now.getTime() - 90 * 86_400_000);
  const [d] = await db
    .select({ n: sql<number>`count(*)` })
    .from(billingDisputes)
    .where(gte(billingDisputes.openedAt, since))
    .all();
  const [p] = await db
    .select({ n: sql<number>`count(*)` })
    .from(billingInvoices)
    .where(and(eq(billingInvoices.status, "paid"), gte(billingInvoices.paidAt, since)))
    .all();
  return { disputes: Number(d?.n ?? 0), paidInvoices: Number(p?.n ?? 0) };
}
