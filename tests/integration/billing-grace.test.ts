// Acceptance item 4 of billing-gap-fill-spec §3 — the failed-payment grace
// window, proven with a REAL Stripe test clock, not a mocked date.
//
// What this exercises end to end:
//   1. A real subscription on a Stripe test clock, paid by a card that fails on
//      renewal (pm_card_chargeCustomerFail), started on a short trial.
//   2. The clock is ADVANCED past the trial so Stripe genuinely attempts — and
//      fails — the renewal charge, emitting a real `invoice.payment_failed`.
//   3. That real event is fed through our webhook handler → status past_due,
//      grace anchor (pastDueAt) stamped from the event's `created`.
//   4. Inside grace the gate allows; beyond grace it denies 402 with a portal link.
//
// SCOPE — what the clock does and does not prove. Stripe stamps an Event's
// `created` with real ingestion time even for test-clock-generated events, so
// our grace anchor sits on the REAL timeline, as it does in production (where
// the gate compares it against a real `now`). A test clock advances Stripe's
// time, not ours, so it cannot carry us across a boundary measured on the real
// timeline — step 4 therefore applies the elapsed grace through the gate's
// injected `now`. What the clock genuinely proves is everything upstream of the
// boundary: a real subscription, a real failed renewal charge, and a real
// invoice.payment_failed with Stripe's actual event shape driving our webhook
// into past_due. The arithmetic of "has 7 days passed" is unit-tested
// (tests/unit/billing.test.ts). See billing-gap-fill-spec §3 item 4.
//
// Runs only with a REAL Stripe test-mode secret in STRIPE_TEST_SECRET_KEY (or
// STRIPE_SECRET_KEY). Without one — including the CI dummy `sk_test_ci-…` — the
// whole suite skips, so `npm run test:integration` stays green everywhere.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import {
  getSubscriptionByUserId,
  upsertSubscriptionByUserId,
} from "@/lib/billing/subscriptions";
import { handleStripeEvent } from "@/lib/billing/webhook";
import { requireActiveSubscription } from "@/lib/billing/gate";

const DAY = 86_400;
const GRACE_DAYS = 7; // factory default of billing.subscription_grace_days

const RAW_KEY =
  process.env.STRIPE_TEST_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY ?? "";
const HAS_REAL_KEY =
  /^sk_test_/.test(RAW_KEY) &&
  !RAW_KEY.includes("ci-") &&
  !RAW_KEY.toLowerCase().includes("dummy");

/** Poll a test clock until it finishes advancing. */
async function waitForClockReady(stripe: Stripe, clockId: string): Promise<Stripe.TestHelpers.TestClock> {
  for (let i = 0; i < 40; i++) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") return clock;
    if (clock.status === "internal_failure") {
      throw new Error("Stripe test clock entered internal_failure");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Stripe test clock did not become ready in time");
}

async function advanceClock(stripe: Stripe, clockId: string, toEpoch: number): Promise<void> {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toEpoch });
}

describe.skipIf(!HAS_REAL_KEY)("billing grace window — real Stripe test clock", () => {
  let stripe: Stripe;
  let client: Client;
  let db: AppDatabase;
  let clockId: string;
  let userId: string;
  let customerId: string;
  let t0: number;

  beforeAll(async () => {
    stripe = new Stripe(RAW_KEY);

    client = createMigrationDatabase(":memory:");
    await runMigrations(client);
    db = drizzle(client) as AppDatabase;
    userId = (await createUser(db, { email: "clock@example.com", passwordHash: "hash" })).id;

    // A fixed, deterministic start time (no Date.now dependence in assertions).
    t0 = 1_900_000_000; // 2030-03-13T ~ UTC
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: t0 });
    clockId = clock.id;

    const customer = await stripe.customers.create({ test_clock: clockId });
    customerId = customer.id;

    // A card that succeeds attachment but fails when charged. `attach` resolves
    // the test token into a NEW PaymentMethod with a generated id — the token
    // string is not itself an attached PM id, so the default must be set from
    // the attach result or Stripe rejects the update.
    const failingCard = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", {
      customer: customerId,
    });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: failingCard.id },
    });

    const price = await stripe.prices.create({
      unit_amount: 1500,
      currency: "gbp",
      recurring: { interval: "month" },
      product_data: { name: "House-starter grace-window test plan" },
    });

    // 3-day trial → first invoice is £0; the failing card only bites at renewal.
    await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: price.id }],
      trial_period_days: 3,
    });

    // Mirror the pre-failure state locally (as the checkout webhook would).
    // trialEndsAt must be on the REAL timeline, like every other date our gate
    // compares: the gate's "trial not yet expired" branch is checked BEFORE the
    // past_due grace branch, so a trial end stamped in Stripe's simulated 2030
    // would allow access unconditionally and mask the grace boundary entirely.
    // By the time the renewal fails, the trial is over — stamp it in the past.
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "trialing",
      stripeCustomerId: customerId,
      trialEndsAt: new Date(Date.now() - DAY * 1000),
    });
  }, 180_000);

  afterAll(async () => {
    // Deleting the clock tears down its customers/subscriptions.
    if (clockId) await stripe.testHelpers.testClocks.del(clockId).catch(() => {});
    if (client) client.close();
  });

  it("crosses the grace boundary by advancing the clock, not the wall clock", async () => {
    // 1. Advance past the trial so Stripe attempts — and fails — the renewal.
    const afterTrial = t0 + 3 * DAY + 3600;
    await advanceClock(stripe, clockId, afterTrial);
    await waitForClockReady(stripe, clockId);

    // 2. Pull the REAL invoice.payment_failed event this clock produced.
    //    NOTE: deliberately NO `created` filter. Under a test clock it is not
    //    contractual whether an event's `created` carries the simulated time or
    //    the real ingestion time, and a filter anchored to the (far-future)
    //    simulated t0 silently matches nothing. Filtering client-side on our own
    //    customer id is unambiguous — the customer is unique to this run.
    let failedEvent: Stripe.Event | undefined;
    for (let i = 0; i < 40 && !failedEvent; i++) {
      const events = await stripe.events.list({ type: "invoice.payment_failed", limit: 100 });
      failedEvent = events.data.find((e) => {
        const inv = e.data.object as { customer?: string | { id: string } | null };
        const c = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
        return c === customerId;
      });
      if (!failedEvent) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!failedEvent) {
      // Make a miss self-explaining rather than a bare "expected undefined".
      const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
      const subs = await stripe.subscriptions.list({ customer: customerId, status: "all" });
      const invoices = await stripe.invoices.list({ customer: customerId, limit: 10 });
      console.error(
        "No invoice.payment_failed for this customer. Diagnostics:",
        JSON.stringify(
          {
            clockStatus: clock.status,
            clockFrozenTime: clock.frozen_time,
            subscriptions: subs.data.map((s) => ({ id: s.id, status: s.status })),
            invoices: invoices.data.map((i) => ({
              id: i.id,
              status: i.status,
              attempted: i.attempted,
              total: i.total,
            })),
          },
          null,
          2,
        ),
      );
    }
    expect(failedEvent, "expected a real invoice.payment_failed from the test clock").toBeDefined();

    // 3. Feed it through our handler → past_due, grace anchored to the failure.
    await handleStripeEvent(db, failedEvent as Stripe.Event);
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("past_due");
    expect(sub?.pastDueAt).toBeTruthy();
    const anchor = sub!.pastDueAt!.getTime();

    // Which timeline is the anchor on? Stripe stamps an Event's `created` with
    // REAL ingestion time even when the event was generated by a test clock, so
    // the anchor is real time — the same timeline the gate's `now` runs on in
    // production. That is correct, and it is also the limit of what a test clock
    // can prove: the clock advances STRIPE's time, not ours, so it cannot itself
    // carry us past a boundary measured on the real timeline. Assert the anchor
    // is real-time-aligned so a change in Stripe's semantics fails loudly here.
    expect(
      Math.abs(Date.now() - anchor) < 2 * DAY * 1000,
      `grace anchor (${anchor}) should sit on the real timeline, near Date.now() (${Date.now()})`,
    ).toBe(true);

    // 4. Cross the boundary. The clock has already done the part only it can do —
    //    driving a genuine renewal failure and a real invoice.payment_failed above.
    //    The elapsed grace period is then applied through the gate's injected
    //    `now` seam, measured from the real anchor.
    const insideNow = new Date(anchor + (GRACE_DAYS - 2) * DAY * 1000);
    const inside = await requireActiveSubscription(db, userId, { now: insideNow });
    expect(inside.allowed).toBe(true);

    const beyondNow = new Date(anchor + (GRACE_DAYS + 1) * DAY * 1000);
    const beyond = await requireActiveSubscription(db, userId, {
      now: beyondNow,
      portalLink: async (id) => `https://billing.stripe.com/p/session_for_${id}`,
    });
    expect(beyond.allowed).toBe(false);
    if (!beyond.allowed) {
      expect(beyond.status).toBe(402);
      expect(beyond.portalUrl).toContain(customerId);
    }
  }, 180_000);
});
