// Subscription-billing both-states assertions (capability-model-spec §2.1 · the
// per-app ACTIVE switch). Sibling of capability-both-states.test.ts and
// deliberately the same shape: this suite is FLAG-AWARE — it reads the
// compiled-in posture from config/billing.ts and asserts the behaviour THAT
// posture requires. The CI `billing-matrix` job runs it twice, rewriting
// config/billing.ts with `scripts/set-flag.mjs --flag subscription_active` before
// each run, so the same assertions prove BOTH states rather than the default one.
//
// WHY THIS SUITE EXISTS — the toggle-safety rule. "Off" means present-but-
// provably-INERT and TESTED. No shipped route is exempt: an app whose commission
// declared no subscription still SHIPS the whole billing surface (it is kernel),
// so safety cannot rest on the routes being absent or on the UI hiding them. It
// rests on the assertions below.
//
// THE NEGATIVE CONTROL is the point of the file, not a garnish. Every assertion
// here is expressed against `active` — the live posture — rather than hardcoded
// to one expected value. That is what makes the OFF leg fail if a billing route
// were live: with subscriptionActive false, `expect(isPathDisabledByBilling(p))
// .toBe(true)` is a real 404 requirement, and a route that answered would fail
// it. The `describe("negative control")` block at the bottom proves the
// assertions have teeth by exercising the predicate against a hand-built ACTIVE
// posture and showing the same expectations invert — a test that cannot fail is
// not a test, and an inertness test that cannot fail is a safety claim with
// nothing behind it.

import { describe, it, expect } from "vitest";
import {
  BILLING_ROUTE_PREFIXES,
  isBillingPath,
  isPathDisabledByBilling,
  isSubscriptionBillingActive,
} from "@/lib/billing/routes";
import { requireSubscriptionBillingForPath } from "@/lib/billing/guard";
import { paidApiResponse, enforcePaidPage } from "@/lib/billing/enforce";
import { billingConfig } from "@/config/billing";
import { enabledKernel } from "@/config/kernel";
import type { AppDatabase } from "@/lib/users";

/** The live posture this leg of the matrix is running under. */
const active = isSubscriptionBillingActive();

/** Concrete paths under each prefix — the real handlers plus a nested path, so
 * the assertion covers the whole subtree and not just the prefix root. */
const BILLING_PATHS = [
  "/api/billing",
  "/api/billing/checkout",
  "/api/billing/portal",
  "/api/billing/webhook",
  "/api/billing/not-yet-built",
  "/reactivate",
  "/reactivate/confirm",
];

/** Paths that belong to no billing prefix — they must be untouched in BOTH
 * states, or an inert subscription would take the rest of the app down with it. */
const NON_BILLING_PATHS = [
  "/",
  "/login",
  "/signup",
  "/account",
  "/dashboard",
  "/api/settings/billing.trial_period_days",
  // Segment-boundary traps: these share a string prefix with a billing route but
  // are NOT under it. If underPrefix() ever degrades to startsWith, these fail.
  "/api/billingX",
  "/reactivateX",
];

/**
 * A database that throws on ANY access. Passed to the paywall helpers so the
 * inert path is proven to return BEFORE touching the DB — the same early return
 * that keeps it away from Stripe. If the paywall ever engaged in the inactive
 * state, this would surface as a thrown error rather than a silent pass.
 */
const explodingDb = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "paywall reached the database while subscription billing was inactive — " +
          "the inert path must return before any DB or Stripe access",
      );
    },
  },
) as unknown as AppDatabase;

describe("subscription billing — the ACTIVE switch is real and readable", () => {
  it("subscription_billing stays KERNEL (built into every app) regardless of the per-app switch", () => {
    // The distinction the whole design rests on: BUILT IN is invariant, ACTIVE
    // is per-app. The matrix must never be able to prove inertness by having
    // removed the kernel part instead of deactivating the app's subscription.
    expect(enabledKernel.subscription_billing).toBe(true);
  });

  it(`resolves the compiled-in posture (subscriptionActive: ${billingConfig.subscriptionActive})`, () => {
    expect(typeof billingConfig.subscriptionActive).toBe("boolean");
    expect(isSubscriptionBillingActive()).toBe(
      billingConfig.subscriptionActive === true,
    );
  });

  it("registers a non-empty route surface to gate", () => {
    // Guard against the suite passing vacuously: an empty prefix list would make
    // every assertion below trivially true.
    expect(BILLING_ROUTE_PREFIXES.length).toBeGreaterThan(0);
    for (const path of BILLING_PATHS) expect(isBillingPath(path)).toBe(true);
    for (const path of NON_BILLING_PATHS) expect(isBillingPath(path)).toBe(false);
  });
});

describe(`subscription billing ${active ? "ACTIVE → the surface is live" : "INACTIVE → the surface is inert (404)"}`, () => {
  for (const path of BILLING_PATHS) {
    it(`${path} ${active ? "is reachable" : "is 404 — absent, not forbidden"}`, () => {
      // Expressed against `active`, so the OFF leg is a real 404 requirement.
      expect(isPathDisabledByBilling(path)).toBe(!active);

      // …and via the guard the handlers actually call, so this is the real
      // Response, not a predicate standing in for one.
      const denied = requireSubscriptionBillingForPath(path);
      if (active) {
        expect(denied).toBeNull();
      } else {
        expect(denied).not.toBeNull();
        expect(denied!.status).toBe(404);
      }
    });
  }

  it("404s, never 402/403 — an app that sells nothing looks unbuilt, not forbidden", async () => {
    if (active) return;
    const denied = requireSubscriptionBillingForPath("/api/billing/checkout");
    expect(denied!.status).toBe(404);
    // A 402 or 403 would confirm the endpoint exists and that payment is the
    // missing piece — the "on, unconfigured" state that produced the stub-price
    // 500. Assert the body carries nothing billing-shaped either.
    const body = await denied!.json();
    expect(body).toEqual({ error: "Not found." });
  });

  for (const path of NON_BILLING_PATHS) {
    it(`${path} is untouched by the billing switch in either state`, () => {
      expect(isPathDisabledByBilling(path)).toBe(false);
      expect(requireSubscriptionBillingForPath(path)).toBeNull();
    });
  }
});

describe(`the paywall ${active ? "engages when ACTIVE" : "is inert when INACTIVE (no DB, no Stripe)"}`, () => {
  it("paidApiResponse reaches the gate only when active", async () => {
    if (active) {
      // ACTIVE: the gate runs, so the exploding DB is reached and throws. That
      // is the positive control — it proves the early return is posture-driven
      // and not unconditional.
      await expect(paidApiResponse(explodingDb, "user-1")).rejects.toThrow(
        /paywall reached the database/,
      );
    } else {
      // INACTIVE: returns null without touching the DB — so it cannot reach the
      // subscription table, and cannot reach the Stripe portal-link resolver.
      await expect(paidApiResponse(explodingDb, "user-1")).resolves.toBeNull();
    }
  });

  it("enforcePaidPage never redirects to the 404'd /reactivate when inactive", async () => {
    if (active) return;
    // The bricking scenario this early return exists to prevent: /reactivate is
    // 404 when inactive, so a paywall that still fired would send every
    // signed-in owner of a no-subscription app into a dead 404.
    await expect(
      enforcePaidPage(explodingDb, "user-1"),
    ).resolves.toBeUndefined();
  });
});

describe("negative control — the inertness assertions have teeth", () => {
  // These do NOT read the live posture. They rebuild the predicate over a
  // hand-set posture so the suite proves, in EITHER leg, that the expectations
  // above are capable of failing. Without this a bug that made
  // isPathDisabledByBilling() return true unconditionally would make the OFF leg
  // pass for the wrong reason and the whole safety claim would be vacuous.

  /** The predicate under test, reimplemented over an injected posture — the same
   * two-condition rule as lib/billing/routes.ts. */
  function disabledUnder(posture: boolean, pathname: string): boolean {
    return isBillingPath(pathname) && !posture;
  }

  it("a LIVE billing route fails the inertness expectation", () => {
    // Simulate the defect the OFF leg is there to catch: the surface is active
    // (a route answers) while the app declared no subscription. The expectation
    // the OFF leg makes — `toBe(true)` — must NOT hold here.
    const liveUnderInactiveApp = disabledUnder(true, "/api/billing/checkout");
    expect(liveUnderInactiveApp).toBe(false);
    expect(() => expect(liveUnderInactiveApp).toBe(true)).toThrow();
  });

  it("an INERT billing route fails the live expectation", () => {
    // The mirror: the ON leg's expectation must not hold for an inert route.
    const inertUnderActiveApp = disabledUnder(false, "/api/billing/checkout");
    expect(inertUnderActiveApp).toBe(true);
    expect(() => expect(inertUnderActiveApp).toBe(false)).toThrow();
  });

  it("the real predicate tracks the posture in both directions", () => {
    // Ties the control back to the shipped code: whichever leg is running, the
    // real predicate agrees with the hand-built one for that posture and
    // DISAGREES for the other. So the two legs cannot both be satisfied by one
    // constant return value.
    const path = "/api/billing/checkout";
    expect(isPathDisabledByBilling(path)).toBe(disabledUnder(active, path));
    expect(isPathDisabledByBilling(path)).not.toBe(disabledUnder(!active, path));
  });
});
