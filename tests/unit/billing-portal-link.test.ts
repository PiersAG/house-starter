// #373: when Stripe fails to make a billing-portal link, the paywall still
// answers its plain "please pay" 402 (without the link) and the failure goes to
// the app's error log — it never becomes an opaque 500.

import { describe, expect, it, vi } from "vitest";

const recorded: Array<Record<string, unknown>> = [];
vi.mock("@/lib/observability/error-log", () => ({
  recordError: async (input: Record<string, unknown>) => {
    recorded.push(input);
    return true;
  },
}));
vi.mock("@/lib/billing/stripe", () => ({
  getStripe: () => ({
    billingPortal: {
      sessions: {
        create: async () => {
          throw new Error("Stripe is down");
        },
      },
    },
  }),
}));

describe("stripePortalLink", () => {
  it("returns null and logs when Stripe fails", async () => {
    const { stripePortalLink } = await import("@/lib/billing/gate");
    await expect(stripePortalLink("cus_1", "https://app.example.com/reactivate")).resolves.toBeNull();
    expect(recorded.at(-1)).toMatchObject({ route: "lib/billing/gate.ts", context: { stage: "portal-link" } });
    expect(String(recorded.at(-1)?.stack)).toContain("Stripe is down");
  });
});
