// @vitest-environment node
// Sales tax / VAT at checkout (app-business-core issue 523). Acceptance: "checkout
// payload carries automatic_tax enabled (tested both states)". CEO ruling 2026-11-03:
// VAT is off until the threshold, so the template ships the switch off.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { billingConfig } from "@/config/billing";
import { checkoutTaxParams } from "@/lib/billing/tax";

describe("#523 tax at checkout, both states", () => {
  it("ON: Stripe Tax works the tax out, from a required address, with tax-id collection", () => {
    expect(checkoutTaxParams(true)).toEqual({
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
    });
  });

  it("OFF: the session carries nothing about tax", () => {
    expect(checkoutTaxParams(false)).toEqual({});
  });

  it("the template ships it off (VAT off until the threshold, CEO ruling 2026-11-03)", () => {
    expect(billingConfig.automaticTax).toBe(false);
  });

  it("the checkout route spreads it into the session from the config switch", () => {
    const src = readFileSync("app/api/billing/checkout/route.ts", "utf8");
    expect(src).toContain("...checkoutTaxParams(billingConfig.automaticTax),");
    expect(src).not.toMatch(/automatic_tax\s*:/);
  });
});
