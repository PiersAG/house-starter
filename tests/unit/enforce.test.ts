// Subscription paywall enforcement (step 5) — the state matrix. Exercises the
// wiring (lib/billing/enforce.ts) against a REAL migrated DB with a real
// subscription row in each state, so we prove what the WIRING does, not just the
// underlying gate (which billing.test.ts already covers). No Stripe is called:
// none of these rows carry a stripeCustomerId, so the portal resolver short-
// circuits to null.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import { upsertSubscriptionByUserId } from "@/lib/billing/subscriptions";
import {
  paidApiResponse,
  enforcePaidApi,
  enforcePaidPage,
} from "@/lib/billing/enforce";

const DAY = 86_400_000;
const NOW = new Date("2026-07-21T12:00:00Z");

let client: Client;
let db: AppDatabase;
let userId: string;

beforeEach(async () => {
  client = createMigrationDatabase(":memory:");
  await runMigrations(client); // also seeds billing.subscription_grace_days (=7, kernel)
  db = drizzle(client) as AppDatabase;
  const u = await createUser(db, { email: "owner@test.example", passwordHash: "h" });
  userId = u.id;
});
afterEach(() => client.close());

async function setSub(patch: {
  status: string;
  trialEndsAt?: Date | null;
  pastDueAt?: Date | null;
}): Promise<void> {
  await upsertSubscriptionByUserId(db, { userId, ...patch });
}

describe("paywall — ALLOWED subscription states (paidApiResponse → null)", () => {
  it("active", async () => {
    await setSub({ status: "active" });
    expect(await paidApiResponse(db, userId, { now: NOW })).toBeNull();
  });

  it("trialing", async () => {
    await setSub({ status: "trialing" });
    expect(await paidApiResponse(db, userId, { now: NOW })).toBeNull();
  });

  it("trial not yet expired (trialEndsAt in the future)", async () => {
    await setSub({ status: "incomplete", trialEndsAt: new Date(NOW.getTime() + 3 * DAY) });
    expect(await paidApiResponse(db, userId, { now: NOW })).toBeNull();
  });

  it("past_due WITHIN the grace window (2 of 7 days)", async () => {
    await setSub({ status: "past_due", pastDueAt: new Date(NOW.getTime() - 2 * DAY) });
    expect(await paidApiResponse(db, userId, { now: NOW })).toBeNull();
  });
});

describe("paywall — BLOCKED states (paidApiResponse → 402 + portalUrl field)", () => {
  async function assert402(): Promise<Record<string, unknown>> {
    const res = await paidApiResponse(db, userId, { now: NOW });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(402);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("portalUrl"); // present; null when no Stripe customer
    expect(body).toHaveProperty("error");
    return body;
  }

  it("past_due BEYOND the grace window (10 of 7 days)", async () => {
    await setSub({ status: "past_due", pastDueAt: new Date(NOW.getTime() - 10 * DAY) });
    await assert402();
  });

  it("canceled", async () => {
    await setSub({ status: "canceled" });
    await assert402();
  });

  it("no subscription at all", async () => {
    await assert402();
  });
});

describe("enforcePaidApi — config-driven open vs gated (isGatedPath)", () => {
  it("an OPEN path is never gated, even for an unpaid user → null", async () => {
    // No subscription (unpaid), but /api/billing/portal is not a gated prefix,
    // so an unpaid owner can always reach it to pay.
    expect(
      await enforcePaidApi(db, userId, "/api/billing/portal", { now: NOW }),
    ).toBeNull();
  });
});

describe("enforcePaidPage — redirect on deny, pass on allow", () => {
  it("allowed subscription → returns without redirecting", async () => {
    await setSub({ status: "active" });
    await expect(enforcePaidPage(db, userId, { now: NOW })).resolves.toBeUndefined();
  });

  it("unpaid → redirects (throws the Next redirect signal)", async () => {
    await setSub({ status: "canceled" });
    await expect(enforcePaidPage(db, userId, { now: NOW })).rejects.toThrow();
  });
});
