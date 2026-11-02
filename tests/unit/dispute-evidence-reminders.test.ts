// @vitest-environment node
// The two parts of #370 left open by bundle S13 (PiersAG/app-business-core#370):
// (1) a reminder before the evidence deadline — run by the daily job; and (2) the
// evidence for Stripe's dispute form assembled automatically (Matt Murphy #138: "a
// response template … with transaction logs delivery confirmations a refund policy
// … preloaded"). Against a real in-memory database. Both states of the switch:
// subscription billing on (reminders sent) and off (nothing runs).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import { auditEvents, billingDisputes, billingInvoices, subscriptions } from "@/lib/schema";
import { assembleEvidence, renderEvidence } from "@/lib/disputes/evidence";
import { NEEDS_RESPONSE, REMINDER_DAYS, runDisputeReminders } from "@/lib/disputes/reminders";
import { clearCapturedEmails, getCapturedEmails, sendEmail } from "@/lib/email/send";
import { disputeReminderTemplate } from "@/lib/email/templates/disputes";

let client: Client;
let db: AppDatabase;
const NOW = new Date("2026-11-02T09:00:00Z");
const DAY = 86_400_000;
const site = { appName: "Pawsome", baseUrl: "https://app.example.com" };

async function setup(opts: { due: Date | null; status?: string; id?: string }): Promise<string> {
  const id = opts.id ?? "dp_1";
  const existing = await db.select().from(subscriptions).all();
  if (existing.length === 0) {
    const u = await createUser(db, { email: "jo@dogs.example", passwordHash: "hash" });
    await db.insert(subscriptions).values({ id: "sub-row-1", userId: u.id, status: "active", stripeCustomerId: "cus_1" }).run();
    await db
      .insert(billingInvoices)
      .values({
        stripeInvoiceId: "in_1",
        stripeCustomerId: "cus_1",
        userId: u.id,
        status: "paid",
        amountPaid: 1500,
        amountDue: 1500,
        currency: "gbp",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/1",
        paidAt: new Date(NOW.getTime() - 20 * DAY),
        receiptSentAt: new Date(NOW.getTime() - 20 * DAY),
      })
      .run();
    await db
      .insert(auditEvents)
      .values({ id: "audit-1", action: "plan_changed", actor: u.id, subjectUserId: u.id, target: "subscription", occurredAt: new Date(NOW.getTime() - 19 * DAY) })
      .run();
  }
  await db
    .insert(billingDisputes)
    .values({
      stripeDisputeId: id,
      stripeChargeId: "ch_1",
      stripeCustomerId: "cus_1",
      amount: 1500,
      currency: "gbp",
      reason: "fraudulent",
      status: opts.status ?? "needs_response",
      evidenceDueBy: opts.due,
      openedAt: new Date(NOW.getTime() - 5 * DAY),
    })
    .run();
  return id;
}

const deps = (over: Partial<Parameters<typeof runDisputeReminders>[1]> = {}) => ({
  now: NOW,
  enabled: true,
  ownerEmail: "owner@pawsome.example",
  send: sendEmail,
  ...site,
  ...over,
});

beforeEach(async () => {
  client = createMigrationDatabase(":memory:");
  await runMigrations(client);
  db = drizzle(client) as AppDatabase;
  clearCapturedEmails();
});
afterEach(() => client.close());

describe("#370 (2) the evidence pack is assembled automatically", () => {
  it("fills Stripe's evidence fields from the app's own records", async () => {
    const id = await setup({ due: new Date(NOW.getTime() + 5 * DAY) });
    const pack = await assembleEvidence(db, id, site);
    expect(pack).not.toBeNull();
    const f = pack!.fields;
    expect(f.customer_email_address).toBe("jo@dogs.example");
    expect(f.receipt).toContain("in_1");
    expect(f.receipt).toContain("£15.00");
    expect(f.receipt).toContain("receipt emailed");
    expect(f.refund_policy).toContain("https://app.example.com/refund-policy");
    expect(f.refund_policy).toContain("we refund that payment in full");
    expect(f.refund_policy_disclosure).toContain("above the pay button");
    expect(f.access_activity_log).toContain("plan_changed");
    expect(f.product_description).toContain("Pawsome");
    expect(pack!.byHand.length).toBeGreaterThan(0);
    const text = renderEvidence(pack!);
    for (const name of Object.keys(f)) expect(text).toContain(`== ${name} ==`);
  });

  it("is null for a dispute the app has no record of", async () => {
    expect(await assembleEvidence(db, "dp_unknown", site)).toBeNull();
  });

  it("says so when the customer has no invoices or activity", async () => {
    await db
      .insert(billingDisputes)
      .values({ stripeDisputeId: "dp_lone", stripeCustomerId: "cus_none", amount: 900, currency: "gbp", status: "needs_response" })
      .run();
    const pack = await assembleEvidence(db, "dp_lone", site);
    expect(pack!.fields.receipt).toMatch(/No invoice/);
    expect(pack!.fields.access_activity_log).toMatch(/No account activity/);
    expect(pack!.fields.customer_email_address).toBeUndefined();
  });
});

describe("#370 (1) a reminder before the evidence deadline", () => {
  it(`emails the owner once a day in the last ${REMINDER_DAYS} days, with the evidence pack`, async () => {
    await setup({ due: new Date(NOW.getTime() + 2 * DAY) });
    const run = await runDisputeReminders(db, deps());
    expect(run).toEqual({ due: 1, sent: 1, skipped: null });
    const [mail] = getCapturedEmails();
    expect(mail.to).toBe("owner@pawsome.example");
    expect(mail.template).toBe("dispute-deadline-reminder");
    expect(mail.subject).toContain("2 days left");
    expect(mail.text).toContain("== receipt ==");
    expect(mail.text).toContain("jo@dogs.example");
  });

  it("does not remind early, after the deadline, or once the dispute is answered or decided", async () => {
    await setup({ id: "dp_early", due: new Date(NOW.getTime() + (REMINDER_DAYS + 1) * DAY) });
    await setup({ id: "dp_past", due: new Date(NOW.getTime() - DAY) });
    await setup({ id: "dp_answered", due: new Date(NOW.getTime() + DAY), status: "under_review" });
    await setup({ id: "dp_lost", due: new Date(NOW.getTime() + DAY), status: "lost" });
    await setup({ id: "dp_nodate", due: null });
    expect(await runDisputeReminders(db, deps())).toEqual({ due: 0, sent: 0, skipped: null });
    expect(getCapturedEmails()).toHaveLength(0);
  });

  it("treats both of Stripe's waiting statuses as needing a response", async () => {
    expect([...NEEDS_RESPONSE]).toEqual(["needs_response", "warning_needs_response"]);
    await setup({ id: "dp_warn", due: new Date(NOW.getTime() + DAY), status: "warning_needs_response" });
    expect((await runDisputeReminders(db, deps())).sent).toBe(1);
    expect(getCapturedEmails()[0].subject).toContain("1 day left");
  });

  it("reports, and sends nothing, when no owner email is set", async () => {
    await setup({ due: new Date(NOW.getTime() + DAY) });
    const reported: string[] = [];
    const run = await runDisputeReminders(db, deps({ ownerEmail: null, report: async (m) => void reported.push(m) }));
    expect(run).toEqual({ due: 1, sent: 0, skipped: "no-owner" });
    expect(reported[0]).toMatch(/no owner email/);
  });

  it("both states: with subscription billing off nothing runs and nothing is sent", async () => {
    await setup({ due: new Date(NOW.getTime() + DAY) });
    expect(await runDisputeReminders(db, deps({ enabled: false }))).toEqual({ due: 0, sent: 0, skipped: "off" });
    expect(getCapturedEmails()).toHaveLength(0);
  });

  it("escapes every value in the email", () => {
    const r = disputeReminderTemplate.render({
      appName: "<b>App</b>",
      disputeId: "dp_<x>",
      amount: "£1.00",
      evidenceDueBy: NOW,
      daysLeft: 3,
      evidence: "<script>alert(1)</script>",
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<b>App</b>");
  });

  it("is run by the daily job, with the subscription-billing switch and the owner email", () => {
    const src = readFileSync("app/api/cron/retention/route.ts", "utf8");
    expect(src).toContain('import { runDisputeReminders } from "@/lib/disputes/reminders";');
    expect(src).toContain("enabled: isSubscriptionBillingActive()");
    expect(src).toContain("ownerEmail: process.env.OWNER_EMAIL?.trim() || null");
  });
});
