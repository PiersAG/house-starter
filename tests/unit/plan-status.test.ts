// #375: the owner's plan card — Subscribe early during the trial, with the days
// left; Manage billing once subscribed.

import { describe, expect, it } from "vitest";
import { daysLeft, describePlan } from "@/lib/plan-status";

const NOW = new Date("2026-11-01T12:00:00Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe("describePlan", () => {
  it("an app-started trial offers Subscribe, with the days left", () => {
    const v = describePlan(
      {
        status: "incomplete",
        trialEndsAt: inDays(9.5),
        stripeCustomerId: null,
      },
      NOW,
    );
    expect(v).toMatchObject({
      kind: "trial",
      title: "Free trial: 10 days left",
      actions: ["checkout"],
    });
  });
  it("says 1 day, not 1 days", () => {
    expect(
      describePlan(
        {
          status: "incomplete",
          trialEndsAt: inDays(0.2),
          stripeCustomerId: null,
        },
        NOW,
      ).title,
    ).toBe("Free trial: 1 day left");
  });
  it("a Stripe trial already has a subscription: Manage billing", () => {
    const v = describePlan(
      { status: "trialing", trialEndsAt: inDays(3), stripeCustomerId: "cus_1" },
      NOW,
    );
    expect(v.kind).toBe("trial");
    expect(v.actions).toEqual(["portal"]);
  });
  it("subscribed: Manage billing", () => {
    expect(
      describePlan(
        { status: "active", trialEndsAt: null, stripeCustomerId: "cus_1" },
        NOW,
      ),
    ).toMatchObject({
      kind: "subscribed",
      actions: ["portal"],
    });
  });
  it("payment failed: update the card in the portal", () => {
    expect(
      describePlan(
        { status: "past_due", trialEndsAt: null, stripeCustomerId: "cus_1" },
        NOW,
      ),
    ).toMatchObject({
      kind: "payment_failed",
      actions: ["portal"],
    });
  });
  it("trial over, or no plan at all: Subscribe", () => {
    expect(
      describePlan(
        {
          status: "incomplete",
          trialEndsAt: inDays(-1),
          stripeCustomerId: null,
        },
        NOW,
      ).kind,
    ).toBe("trial_ended");
    expect(describePlan(undefined, NOW)).toMatchObject({
      kind: "none",
      actions: ["checkout"],
    });
    expect(
      describePlan(
        { status: "canceled", trialEndsAt: null, stripeCustomerId: "cus_1" },
        NOW,
      ).actions,
    ).toEqual(["checkout"]);
  });
  it("daysLeft rounds up and never goes below zero", () => {
    expect(daysLeft(inDays(1.01), NOW)).toBe(2);
    expect(daysLeft(inDays(-3), NOW)).toBe(0);
  });
});
