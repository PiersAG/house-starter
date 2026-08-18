import { describe, expect, it } from "vitest";
import { billingConfig, isGatedPath } from "@/config/billing";

// The two template placeholders, spelled once. Kept in step with
// scripts/check-billing-configured.mjs and provision_stripe_price.py.
const PRICE_STUB = "price_stub_replace_me";
const APP_ID_STUB = "app_stub_replace_me";

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

  // The stub must not survive into a generated app. A non-empty-string assertion
  // does not catch it — "app_stub_replace_me" is a perfectly good non-empty
  // string, which is exactly how the placeholder shipped unnoticed and was sent
  // to Stripe as metadata.app_id on real Checkout Sessions (2026-08-18).
  //
  // Posture is read from the price, the same split scripts/check-billing-
  // configured.mjs makes: the TEMPLATE (and a no-subscription app) keeps the stub
  // price and therefore keeps the stub appId; anything carrying a real price_… id
  // is a provisioned app and must carry a real slug in appId too. No env var, no
  // repo-identity check — the file states its own posture.
  it("carries no unresolved stub — template keeps both, a provisioned app has neither", () => {
    const isTemplatePosture = billingConfig.priceIds.default === PRICE_STUB;
    if (isTemplatePosture) {
      // Template: the stubs are intentional and must stay paired. A real appId
      // hardcoded here would be inherited by every generated app.
      expect(billingConfig.appId).toBe(APP_ID_STUB);
    } else {
      // Provisioned app: both fields stamped by provision_stripe_price.py.
      expect(billingConfig.appId).not.toBe(APP_ID_STUB);
      expect(billingConfig.appId).not.toContain("_replace_me");
      expect(billingConfig.appId.trim().length).toBeGreaterThan(0);
      expect(billingConfig.priceIds.default).not.toContain("_replace_me");
      expect(billingConfig.priceIds.default).toMatch(/^price_[A-Za-z0-9]+$/);
    }
  });

  it("still resolves gated paths on a segment boundary", () => {
    // Behaviour unchanged by the per-app fields.
    expect(isGatedPath("/anything")).toBe(false); // template default: nothing gated
  });
});
