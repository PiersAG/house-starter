// Acceptance item 4 of billing-gap-fill-spec §3 — the failed-payment grace
// window, proven with a REAL Stripe test clock, not a mocked date.
//
// What this exercises end to end:
//   1. A real subscription on a Stripe test clock, paid by a card that fails on
//      renewal (pm_card_chargeCustomerFail), started on a short trial.
//   2. The clock is ADVANCED past the trial so Stripe genuinely attempts — and
//      fails — the renewal charge, emitting a real `invoice.payment_failed`.
//   3. That real event is fed through our webhook handler → status past_due,
//      grace anchor (pastDueAt) stamped from the event's (test-clock) time.
//   4. The clock is ADVANCED again, past the grace boundary. The gate is then
//      evaluated at the clock's advanced frozen_time — so the boundary is
//      crossed by the clock itself, exactly as the spec demands. Inside grace
//      the gate allows; beyond grace it denies 402.
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

    // A card that succeeds attachment but fails when charged.
    await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: "pm_card_chargeCustomerFail" },
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
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "trialing",
      stripeCustomerId: customerId,
      trialEndsAt: new Date((t0 + 3 * DAY) * 1000),
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
    let failedEvent: Stripe.Event | undefined;
    for (let i = 0; i < 20 && !failedEvent; i++) {
      const events = await stripe.events.list({
        type: "invoice.payment_failed",
        created: { gte: t0 },
        limit: 100,
      });
      failedEvent = events.data.find((e) => {
        const inv = e.data.object as { customer?: string | { id: string } | null };
        const c = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
        return c === customerId;
      });
      if (!failedEvent) await new Promise((r) => setTimeout(r, 2000));
    }
    expect(failedEvent, "expected a real invoice.payment_failed from the test clock").toBeDefined();

    // 3. Feed it through our handler → past_due, grace anchored to the clock time.
    await handleStripeEvent(db, failedEvent as Stripe.Event);
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("past_due");
    expect(sub?.pastDueAt).toBeTruthy();
    const anchor = sub!.pastDueAt!.getTime();

    // 4a. Inside the window: advance the clock to anchor + (GRACE-2) days and
    //     evaluate the gate at the clock's advanced time → still allowed.
    const insideEpoch = Math.floor(anchor / 1000) + (GRACE_DAYS - 2) * DAY;
    await advanceClock(stripe, clockId, insideEpoch);
    const insideClock = await waitForClockReady(stripe, clockId);
    const inside = await requireActiveSubscription(db, userId, {
      now: new Date(insideClock.frozen_time * 1000),
    });
    expect(inside.allowed).toBe(true);

    // 4b. Beyond the window: advance PAST anchor + GRACE days and re-evaluate at
    //     the clock's advanced time → denied 402 with a portal link.
    const beyondEpoch = Math.floor(anchor / 1000) + (GRACE_DAYS + 1) * DAY;
    await advanceClock(stripe, clockId, beyondEpoch);
    const beyondClock = await waitForClockReady(stripe, clockId);
    const beyond = await requireActiveSubscription(db, userId, {
      now: new Date(beyondClock.frozen_time * 1000),
      portalLink: async (id) => `https://billing.stripe.com/p/session_for_${id}`,
    });
    expect(beyond.allowed).toBe(false);
    if (!beyond.allowed) {
      expect(beyond.status).toBe(402);
      expect(beyond.portalUrl).toContain(customerId);
    }
  }, 180_000);
});
