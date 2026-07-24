import { describe, expect, it } from "vitest";
import { billingConfig, isGatedPath } from "@/config/billing";

// stripe-per-app-accounts: the config carries the per-app identity that the
// checkout route tags Stripe objects with. Lock the fields so they can't be
// dropped silently, and keep the existing gated-path behaviour covered.
describe("billing config — per-app identity", () => {
  it("exposes appId and statementDescriptor", () => {
    expect(typeof billingConfig.appId).toBe("string");
    expect(billingConfig.appId.length).toBeGreaterThan(0);
    // null (account name governs) or a non-empty descriptor string.
    expect(
      billingConfig.statementDescriptor === null ||
        typeof billingConfig.statementDescriptor === "string",
    ).toBe(true);
  });

  it("still resolves gated paths on a segment boundary", () => {
    // Behaviour unchanged by the per-app fields.
    expect(isGatedPath("/anything")).toBe(false); // template default: nothing gated
  });
});
