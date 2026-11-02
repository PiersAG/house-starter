// Bundle S13 webhook tests (PiersAG/app-business-core #542, #788, #753, #370),
// against a REAL in-memory libSQL database brought to the current schema by the
// one migration path — same pattern as tests/unit/billing.test.ts. Emails run in
// log mode and are read back from the capture buffer.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import type { Client } from "@libsql/client";
import type Stripe from "stripe";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import { billingDisputes, billingInvoices, stripeEvents } from "@/lib/schema";
import { getSubscriptionByUserId, upsertSubscriptionByUserId } from "@/lib/billing/subscriptions";
import { CLAIM_TAKEOVER_MS, handleStripeEvent } from "@/lib/billing/webhook";
import { clearCapturedEmails, getCapturedEmails } from "@/lib/email/send";

let client: Client;
let db: AppDatabase;
const NOW = new Date("2026-11-01T12:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);

function event(id: string, type: string, object: unknown, created = T): Stripe.Event {
  return { id, type, created, data: { object } } as unknown as Stripe.Event;
}

async function customer(email = "owner@example.com", status = "active"): Promise<string> {
  const u = await createUser(db, { email, passwordHash: "hash" });
  await upsertSubscriptionByUserId(db, { userId: u.id, status, stripeCustomerId: "cus_1" });
  return u.id;
}

const reports: string[] = [];
const opts = {
  now: NOW,
  appName: "Pawsome",
  baseUrl: "https://app.example.com",
  ownerEmail: "ceo@example.com",
  report: (m: string) => {
    reports.push(m);
  },
};

beforeEach(async () => {
  client = createMigrationDatabase(":memory:");
  await runMigrations(client);
  db = drizzle(client) as AppDatabase;
  clearCapturedEmails();
  reports.length = 0;
});
afterEach(() => client.close());

const paid = (id = "in_1", amount = 1500) => ({
  id,
  customer: "cus_1",
  customer_email: "owner@example.com",
  amount_paid: amount,
  amount_due: amount,
  currency: "gbp",
  attempt_count: 1,
  hosted_invoice_url: "https://invoice.stripe.com/i/1",
  status_transitions: { paid_at: T },
});

describe("#542 — the event is recorded before acting, atomically", () => {
  it("two concurrent deliveries of one event apply once", async () => {
    await customer();
    const e = event("evt_paid_1", "invoice.paid", paid());
    const [a, b] = await Promise.all([handleStripeEvent(db, e, opts), handleStripeEvent(db, e, opts)]);
    expect([a.processed, b.processed].sort()).toEqual([false, true]);
    expect([a.duplicate, b.duplicate]).toContain(true);
    expect(getCapturedEmails().filter((m) => m.template === "payment-receipt")).toHaveLength(1);
    const rows = await db.select().from(stripeEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
  });

  it("a redelivery after the event finished is a duplicate and does nothing", async () => {
    await customer();
    const e = event("evt_paid_2", "invoice.paid", paid());
    expect((await handleStripeEvent(db, e, opts)).processed).toBe(true);
    expect(await handleStripeEvent(db, e, opts)).toEqual({ processed: false, duplicate: true });
    expect(getCapturedEmails()).toHaveLength(1);
  });

  it("a failed action releases the claim, so Stripe's retry runs the event", async () => {
    // Force the action to fail part-way: the invoice record's table is missing.
    await customer();
    await client.execute("DROP TABLE billing_invoices");
    const e = event("evt_paid_3", "invoice.paid", paid());
    await expect(handleStripeEvent(db, e, opts)).rejects.toThrow();
    expect(await db.select().from(stripeEvents).all()).toHaveLength(0);
    await runMigrations(client);
    expect((await handleStripeEvent(db, e, opts)).processed).toBe(true);
    expect(getCapturedEmails()).toHaveLength(1);
  });

  it("an email that cannot be sent is sent on Stripe's retry, once", async () => {
    await customer();
    const e = event("evt_paid_5", "invoice.paid", paid("in_5"));
    const saved = process.env.EMAIL_SEND_MODE;
    process.env.EMAIL_SEND_MODE = "broken"; // the send path refuses an unknown mode
    try {
      await expect(handleStripeEvent(db, e, opts)).rejects.toThrow(/EMAIL_SEND_MODE/);
    } finally {
      if (saved === undefined) delete process.env.EMAIL_SEND_MODE;
      else process.env.EMAIL_SEND_MODE = saved;
    }
    const [inv] = await db.select().from(billingInvoices).all();
    expect(inv.receiptSentAt).toBeNull();
    expect((await handleStripeEvent(db, e, opts)).processed).toBe(true);
    expect(getCapturedEmails().filter((m) => m.template === "payment-receipt")).toHaveLength(1);
  });

  it("a failed-payment or dispute email that cannot be sent is sent on the retry", async () => {
    await customer();
    const failedEvt = event("evt_fx", "invoice.payment_failed", {
      id: "in_x",
      customer: "cus_1",
      customer_email: "owner@example.com",
      amount_due: 900,
      currency: "gbp",
      attempt_count: 1,
      next_payment_attempt: T + 86400,
    });
    const disputeEvt = event("evt_dx", "charge.dispute.created", {
      id: "dp_x",
      amount: 900,
      currency: "gbp",
      reason: "general",
      status: "needs_response",
    });
    const saved = process.env.EMAIL_SEND_MODE;
    process.env.EMAIL_SEND_MODE = "broken";
    try {
      await expect(handleStripeEvent(db, failedEvt, opts)).rejects.toThrow();
      await expect(handleStripeEvent(db, disputeEvt, opts)).rejects.toThrow();
    } finally {
      if (saved === undefined) delete process.env.EMAIL_SEND_MODE;
      else process.env.EMAIL_SEND_MODE = saved;
    }
    expect(await db.select().from(billingDisputes).all()).toHaveLength(0);
    await handleStripeEvent(db, failedEvt, opts);
    await handleStripeEvent(db, disputeEvt, opts);
    expect(getCapturedEmails().map((m) => m.template).sort()).toEqual(["dispute-opened", "payment-failed"]);
  });

  it("a claim left 'processing' by a crash is taken over after the window, not before", async () => {
    await customer();
    const e = event("evt_paid_4", "invoice.paid", paid());
    const crashedAt = new Date(NOW.getTime() - 60_000);
    await db.insert(stripeEvents).values({ id: e.id, status: "processing", claimedAt: crashedAt }).run();
    expect(await handleStripeEvent(db, e, opts)).toEqual({ processed: false, duplicate: true });
    const later = new Date(crashedAt.getTime() + CLAIM_TAKEOVER_MS + 1000);
    expect((await handleStripeEvent(db, e, { ...opts, now: later })).processed).toBe(true);
    const [row] = await db.select().from(stripeEvents).where(eq(stripeEvents.id, e.id)).all();
    expect(row.status).toBe("done");
  });
});

describe("#788 — a successful charge runs the business", () => {
  it("marks the invoice paid, activates the subscription, grants access and sends one receipt", async () => {
    const userId = await customer("owner@example.com", "past_due");
    await handleStripeEvent(db, event("evt_p1", "invoice.paid", paid("in_9", 2500)), opts);
    const [inv] = await db.select().from(billingInvoices).all();
    expect(inv).toMatchObject({ stripeInvoiceId: "in_9", status: "paid", amountPaid: 2500, userId });
    expect(inv.receiptSentAt).not.toBeNull();
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("active");
    expect(sub?.pastDueAt).toBeNull();
    const [mail] = getCapturedEmails();
    expect(mail).toMatchObject({ to: "owner@example.com", template: "payment-receipt" });
    expect(mail.text).toContain("£25.00");
    expect(mail.text).toContain("https://invoice.stripe.com/i/1");
  });

  it("a zero invoice (start of a free trial) is recorded but sends no receipt and activates nothing", async () => {
    const userId = await customer("owner@example.com", "incomplete");
    await handleStripeEvent(db, event("evt_p0", "invoice.paid", paid("in_0", 0)), opts);
    expect(await db.select().from(billingInvoices).all()).toHaveLength(1);
    expect(getCapturedEmails()).toHaveLength(0);
    expect((await getSubscriptionByUserId(db, userId))?.status).toBe("incomplete");
  });

  it("the receipt falls back to the account's email when Stripe sends none", async () => {
    await customer("fallback@example.com");
    await handleStripeEvent(db, event("evt_p2", "invoice.paid", { ...paid("in_2"), customer_email: null }), opts);
    expect(getCapturedEmails()[0].to).toBe("fallback@example.com");
  });
});

describe("#753 — failed payments: a three-email sequence while Stripe retries", () => {
  const failed = (attempt: number, next: number | null) => ({
    id: "in_f",
    customer: "cus_1",
    customer_email: "owner@example.com",
    amount_due: 1500,
    currency: "gbp",
    attempt_count: attempt,
    next_payment_attempt: next,
    hosted_invoice_url: "https://invoice.stripe.com/i/f",
  });

  it("sends email 1, 2 and 3 for the first three attempts and nothing for a fourth", async () => {
    await customer();
    for (const n of [1, 2, 3, 4]) {
      await handleStripeEvent(db, event(`evt_f${n}`, "invoice.payment_failed", failed(n, T + 3 * 86400), T + n), opts);
    }
    const mails = getCapturedEmails().filter((m) => m.template === "payment-failed");
    expect(mails.map((m) => m.subject)).toEqual([
      "Your payment failed — please update your card (Pawsome)",
      "Reminder: your payment is still outstanding (Pawsome)",
      "Final notice: update your card to keep your account (Pawsome)",
    ]);
    expect(mails[0].text).toContain("update your card");
    expect(mails[0].text).toContain("https://app.example.com/reactivate");
    expect(mails[0].text).toContain("https://invoice.stripe.com/i/f");
    expect(mails[0].text).toMatch(/try your card again on 4 November 2026/);
    const [inv] = await db.select().from(billingInvoices).all();
    expect(inv).toMatchObject({ status: "payment_failed", dunningEmailsSent: 3, attemptCount: 4 });
  });

  it("the subscription goes past_due, anchored to the first failure", async () => {
    const userId = await customer();
    await handleStripeEvent(db, event("evt_g1", "invoice.payment_failed", failed(1, T + 86400)), opts);
    await handleStripeEvent(db, event("evt_g2", "invoice.payment_failed", failed(2, T + 86400), T + 86400), opts);
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("past_due");
    expect(sub?.pastDueAt?.getTime()).toBe(T * 1000);
  });

  it("reports a failure Stripe will not retry — automatic retries are off", async () => {
    await customer();
    await handleStripeEvent(db, event("evt_h1", "invoice.payment_failed", failed(1, null)), opts);
    expect(reports.join("\n")).toMatch(/retries look switched off/);
    expect(getCapturedEmails()[0].text).toContain("We will not try your card again automatically.");
  });

  it("a payment that recovers after failures restores access", async () => {
    const userId = await customer();
    await handleStripeEvent(db, event("evt_i1", "invoice.payment_failed", failed(1, T + 86400)), opts);
    await handleStripeEvent(db, event("evt_i2", "invoice.paid", paid("in_f")), opts);
    expect((await getSubscriptionByUserId(db, userId))?.status).toBe("active");
    const [inv] = await db.select().from(billingInvoices).all();
    expect(inv.status).toBe("paid");
    // A late "failed" for the same invoice does not un-pay it.
    await handleStripeEvent(db, event("evt_i3", "invoice.payment_failed", failed(2, null), T + 5), opts);
    expect((await db.select().from(billingInvoices).all())[0].status).toBe("paid");
  });
});

describe("#370 — disputes are recorded and the owner is told the deadline", () => {
  const dispute = (status = "needs_response") => ({
    id: "dp_1",
    charge: "ch_1",
    amount: 1500,
    currency: "gbp",
    reason: "fraudulent",
    status,
    evidence_details: { due_by: T + 7 * 86400 },
  });

  it("records the dispute and emails the owner with the deadline and the 90-day rate", async () => {
    await customer();
    await handleStripeEvent(db, event("evt_p", "invoice.paid", paid()), opts);
    await handleStripeEvent(db, event("evt_d1", "charge.dispute.created", dispute()), opts);
    const [row] = await db.select().from(billingDisputes).all();
    expect(row).toMatchObject({ stripeDisputeId: "dp_1", status: "needs_response", amount: 1500, reason: "fraudulent" });
    const mail = getCapturedEmails().find((m) => m.template === "dispute-opened");
    expect(mail?.to).toBe("ceo@example.com");
    expect(mail?.subject).toContain("Action needed by 8 November 2026");
    expect(mail?.text).toContain("1 of 1 paid invoices (100.00%)");
    expect(mail?.text).toContain("0.75%");
  });

  it("records the outcome when the dispute closes", async () => {
    await customer();
    await handleStripeEvent(db, event("evt_d1", "charge.dispute.created", dispute()), opts);
    await handleStripeEvent(db, event("evt_d2", "charge.dispute.closed", dispute("won")), opts);
    const [row] = await db.select().from(billingDisputes).all();
    expect(row.status).toBe("won");
    expect(row.closedAt).not.toBeNull();
  });

  it("with no owner email set, the dispute is still recorded and the gap reported", async () => {
    await customer();
    await handleStripeEvent(db, event("evt_d3", "charge.dispute.created", dispute()), { ...opts, ownerEmail: null });
    expect(await db.select().from(billingDisputes).all()).toHaveLength(1);
    expect(reports.join("\n")).toMatch(/no owner email/);
  });
});
