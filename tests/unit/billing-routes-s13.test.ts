// #354: /refund-policy is part of the subscription-billing surface, so it is live
// when this app sells a subscription and answers 404 when it does not — at the
// edge (isPathDisabledByBilling, used by the middleware) and in the page itself.
// Flag-aware like billing-both-states.test.ts: the CI billing-matrix job runs it
// with subscriptionActive both ways.

import { describe, expect, it, vi } from "vitest";
import {
  BILLING_ROUTE_PREFIXES,
  isBillingPath,
  isPathDisabledByBilling,
  isSubscriptionBillingActive,
} from "@/lib/billing/routes";

const active = isSubscriptionBillingActive();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

describe("/refund-policy follows the billing switch", () => {
  it("is a billing path", () => {
    expect(BILLING_ROUTE_PREFIXES).toContain("/refund-policy");
    expect(isBillingPath("/refund-policy")).toBe(true);
    expect(isBillingPath("/refund-policyX")).toBe(false);
  });

  it(`is ${active ? "served" : "404 at the edge"} in this posture`, () => {
    expect(isPathDisabledByBilling("/refund-policy")).toBe(!active);
  });

  it(`the page ${active ? "renders" : "calls notFound()"} in this posture`, async () => {
    const { default: Page } = await import("@/app/refund-policy/page");
    if (active) expect(Page()).toBeTruthy();
    else expect(() => Page()).toThrow("NEXT_NOT_FOUND");
  });
});
