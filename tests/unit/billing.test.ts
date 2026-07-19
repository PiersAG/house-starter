// Billing skeleton tests (v0 graduation — Candidate 1).
//
// Runs the DI billing modules against a REAL in-memory libSQL database brought
// to the current schema by the one true migration path (lib/migrate.ts), same
// pattern as tests/unit/users.test.ts — no mocked query builder, so what is
// asserted is what production executes.
//
// The two Phase-4 observables the spec pins:
//   • checkout.session.completed sets subscription status = "active";
//   • expired trial + no active subscription → the gate denies with 402.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import type Stripe from "stripe";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import {
  getSubscriptionByUserId,
  updateSubscriptionByStripeCustomerId,
  upsertSubscriptionByUserId,
} from "@/lib/billing/subscriptions";
import { requireActiveSubscription } from "@/lib/billing/gate";
import { handleStripeEvent } from "@/lib/billing/webhook";
import { getStripe, __resetStripeForTests } from "@/lib/billing/stripe";
import { setOwnerValue } from "@/lib/settings/values";

const DAY_MS = 86_400_000;

/** A verified event carrying a `created` time — the shape real Stripe events (and
 *  test-clock events) have; the grace anchor is stamped from it. */
function timedEvent(
  id: string,
  type: string,
  createdSeconds: number,
  object: unknown,
): Stripe.Event {
  return { id, type, created: createdSeconds, data: { object } } as unknown as Stripe.Event;
}

let client: Client;
let db: AppDatabase;

async function freshDb(): Promise<{ client: Client; db: AppDatabase }> {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  return { client: c, db: drizzle(c) as AppDatabase };
}

/** A user row (subscriptions.userId is a FK → users.id, enforced in :memory:). */
async function seedUser(email = "buyer@example.com"): Promise<string> {
  const u = await createUser(db, { email, passwordHash: "hash" });
  return u.id;
}

/** Build a synthetic verified event — the shape handleStripeEvent reads. */
function event(id: string, type: string, object: unknown): Stripe.Event {
  return { id, type, data: { object } } as unknown as Stripe.Event;
}

beforeEach(async () => {
  ({ client, db } = await freshDb());
});

afterEach(() => {
  client.close();
});

describe("webhook — checkout.session.completed", () => {
  it("sets the subscription status to active and links the Stripe ids", async () => {
    const userId = await seedUser();

    const result = await handleStripeEvent(
      db,
      event("evt_checkout_1", "checkout.session.completed", {
        client_reference_id: userId,
        customer: "cus_123",
        subscription: "sub_123",
      }),
    );

    expect(result).toEqual({ processed: true });
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("active");
    expect(sub?.stripeCustomerId).toBe("cus_123");
    expect(sub?.stripeSubscriptionId).toBe("sub_123");
  });

  it("reads the userId from metadata when client_reference_id is absent", async () => {
    const userId = await seedUser("meta@example.com");
    await handleStripeEvent(
      db,
      event("evt_checkout_meta", "checkout.session.completed", {
        metadata: { userId },
        customer: { id: "cus_exp" }, // expanded object form
        subscription: { id: "sub_exp" },
      }),
    );
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("active");
    expect(sub?.stripeCustomerId).toBe("cus_exp");
  });

  it("is idempotent — a redelivered event id is skipped, not double-applied", async () => {
    const userId = await seedUser();
    const e = event("evt_dupe", "checkout.session.completed", {
      client_reference_id: userId,
      customer: "cus_123",
      subscription: "sub_123",
    });
    expect(await handleStripeEvent(db, e)).toEqual({ processed: true });
    expect(await handleStripeEvent(db, e)).toEqual({ processed: false, duplicate: true });
  });
});

describe("webhook — subscription lifecycle + invoice failure", () => {
  it("customer.subscription.updated writes status, price, and period end", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "active",
      stripeCustomerId: "cus_lc",
    });

    const periodEnd = 1893456000; // 2030-01-01, seconds
    await handleStripeEvent(
      db,
      event("evt_updated", "customer.subscription.updated", {
        id: "sub_lc",
        status: "past_due",
        customer: "cus_lc",
        current_period_end: periodEnd,
        items: { data: [{ price: { id: "price_pro" } }] },
      }),
    );

    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("past_due");
    expect(sub?.priceId).toBe("price_pro");
    expect(sub?.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
  });

  it("customer.subscription.deleted marks the subscription canceled", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "active",
      stripeCustomerId: "cus_del",
    });
    await handleStripeEvent(
      db,
      event("evt_deleted", "customer.subscription.deleted", {
        id: "sub_del",
        status: "canceled",
        customer: "cus_del",
      }),
    );
    expect((await getSubscriptionByUserId(db, userId))?.status).toBe("canceled");
  });

  it("invoice.payment_failed marks the subscription past_due", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "active",
      stripeCustomerId: "cus_inv",
    });
    await handleStripeEvent(
      db,
      event("evt_invoice", "invoice.payment_failed", { customer: "cus_inv" }),
    );
    expect((await getSubscriptionByUserId(db, userId))?.status).toBe("past_due");
  });

  it("records but does not act on an unhandled event type", async () => {
    const result = await handleStripeEvent(
      db,
      event("evt_other", "customer.updated", { id: "cus_x" }),
    );
    expect(result).toEqual({ processed: true });
  });
});

describe("gate — requireActiveSubscription", () => {
  it("denies with 402 for an expired trial and no active subscription", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "canceled",
      trialEndsAt: new Date("2020-01-01T00:00:00Z"), // long expired
    });

    const result = await requireActiveSubscription(db, userId);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.status).toBe(402);
  });

  it("denies with 402 when the user has no subscription at all", async () => {
    const userId = await seedUser();
    const result = await requireActiveSubscription(db, userId);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.status).toBe(402);
  });

  it("allows an active subscription", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, { userId, status: "active" });
    expect((await requireActiveSubscription(db, userId)).allowed).toBe(true);
  });

  it("allows a live trial even without an active Stripe subscription", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "incomplete",
      trialEndsAt: new Date("2999-01-01T00:00:00Z"),
    });
    expect((await requireActiveSubscription(db, userId)).allowed).toBe(true);
  });
});

describe("subscriptions repository", () => {
  it("upsert preserves fields not carried by a later event", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "active",
      stripeCustomerId: "cus_keep",
      priceId: "price_keep",
    });
    // A status-only update must not wipe the stored customer/price.
    await upsertSubscriptionByUserId(db, { userId, status: "past_due" });
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("past_due");
    expect(sub?.stripeCustomerId).toBe("cus_keep");
    expect(sub?.priceId).toBe("price_keep");
  });

  it("updateSubscriptionByStripeCustomerId returns 0 when nothing matches", async () => {
    expect(await updateSubscriptionByStripeCustomerId(db, "cus_ghost", { status: "x" })).toBe(0);
  });
});

describe("webhook — past_due grace anchor (pastDueAt)", () => {
  it("invoice.payment_failed stamps pastDueAt from the event time", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "active",
      stripeCustomerId: "cus_g1",
    });
    const failedAt = 1893456000; // 2030-01-01, seconds
    await handleStripeEvent(
      db,
      timedEvent("evt_pf_1", "invoice.payment_failed", failedAt, { customer: "cus_g1" }),
    );
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("past_due");
    expect(sub?.pastDueAt?.getTime()).toBe(failedAt * 1000);
  });

  it("a re-fired invoice.payment_failed keeps the anchor at the FIRST failure", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "active",
      stripeCustomerId: "cus_g2",
    });
    const first = 1893456000;
    const retry = first + 3 * 86400; // Stripe re-fires on dunning retries
    await handleStripeEvent(
      db,
      timedEvent("evt_pf_a", "invoice.payment_failed", first, { customer: "cus_g2" }),
    );
    await handleStripeEvent(
      db,
      timedEvent("evt_pf_b", "invoice.payment_failed", retry, { customer: "cus_g2" }),
    );
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.pastDueAt?.getTime()).toBe(first * 1000);
  });

  it("recovery to active clears the grace anchor", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "past_due",
      stripeCustomerId: "cus_g3",
      pastDueAt: new Date("2030-01-01T00:00:00Z"),
    });
    await handleStripeEvent(
      db,
      timedEvent("evt_rec", "customer.subscription.updated", 1900000000, {
        id: "sub_g3",
        status: "active",
        customer: "cus_g3",
      }),
    );
    const sub = await getSubscriptionByUserId(db, userId);
    expect(sub?.status).toBe("active");
    expect(sub?.pastDueAt).toBeNull();
  });
});

describe("gate — grace window (past_due)", () => {
  const PAST_DUE_AT = new Date("2030-01-01T00:00:00Z");

  async function pastDueSub(userId: string, customerId = "cus_grace"): Promise<void> {
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "past_due",
      stripeCustomerId: customerId,
      pastDueAt: PAST_DUE_AT,
    });
  }

  it("allows a past_due subscription inside the grace window (3 of 7 days)", async () => {
    const userId = await seedUser();
    await pastDueSub(userId);
    const now = new Date(PAST_DUE_AT.getTime() + 3 * DAY_MS);
    expect((await requireActiveSubscription(db, userId, { now })).allowed).toBe(true);
  });

  it("denies with 402 once the grace window has elapsed (8 of 7 days)", async () => {
    const userId = await seedUser();
    await pastDueSub(userId);
    const now = new Date(PAST_DUE_AT.getTime() + 8 * DAY_MS);
    const result = await requireActiveSubscription(db, userId, { now });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.status).toBe(402);
  });

  it("denies exactly at the boundary (grace is elapsed, not remaining)", async () => {
    const userId = await seedUser();
    await pastDueSub(userId);
    const now = new Date(PAST_DUE_AT.getTime() + 7 * DAY_MS);
    expect((await requireActiveSubscription(db, userId, { now })).allowed).toBe(false);
  });

  it("reads the grace length from the registry, not a literal", async () => {
    const userId = await seedUser();
    await pastDueSub(userId);
    // Shorten grace to 2 days via a stored owner value. If the gate read a
    // literal 7 it would still allow at day 3; honouring the override proves it
    // resolves billing.subscription_grace_days through getSetting.
    await setOwnerValue(db, "billing.subscription_grace_days", 2);
    const now = new Date(PAST_DUE_AT.getTime() + 3 * DAY_MS);
    expect((await requireActiveSubscription(db, userId, { now })).allowed).toBe(false);
  });
});

describe("gate — 402 payload", () => {
  it("carries the resolved Stripe portal link when a resolver is supplied", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "canceled",
      stripeCustomerId: "cus_pay",
    });
    const result = await requireActiveSubscription(db, userId, {
      portalLink: async (id) => `https://billing.stripe.com/p/session_for_${id}`,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(402);
      expect(result.portalUrl).toBe("https://billing.stripe.com/p/session_for_cus_pay");
    }
  });

  it("portalUrl is null when there is no Stripe customer to manage", async () => {
    const userId = await seedUser();
    const result = await requireActiveSubscription(db, userId, {
      portalLink: async () => "https://should-not-be-reached",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.portalUrl).toBeNull();
  });

  it("portalUrl is null when no resolver is supplied", async () => {
    const userId = await seedUser();
    await upsertSubscriptionByUserId(db, {
      userId,
      status: "canceled",
      stripeCustomerId: "cus_np",
    });
    const result = await requireActiveSubscription(db, userId);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.portalUrl).toBeNull();
  });
});

describe("stripe client singleton", () => {
  afterEach(() => {
    __resetStripeForTests();
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("throws by name when STRIPE_SECRET_KEY is absent", () => {
    delete process.env.STRIPE_SECRET_KEY;
    __resetStripeForTests();
    expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("constructs once and returns the same instance", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    __resetStripeForTests();
    expect(getStripe()).toBe(getStripe());
  });
});
