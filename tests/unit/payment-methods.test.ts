// @vitest-environment node
// The checkout offers only tested payment methods (PiersAG/app-business-core#780;
// Matt Murphy #146). config/billing.ts `paymentMethods` is passed to Stripe as
// payment_method_types, and every method in it has a written, two-device payment
// path (tests/e2e/payment-paths.ts). Adding a method without its path fails here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { billingConfig } from "@/config/billing";
import { PAYMENT_PATHS } from "../e2e/payment-paths";

describe("#780 every payment method offered has a tested path", () => {
  it("the checkout offers exactly the configured methods (Stripe does not add its own)", () => {
    const src = readFileSync("app/api/billing/checkout/route.ts", "utf8");
    expect(src).toContain("payment_method_types: billingConfig.paymentMethods,");
  });

  it("the template offers card only", () => {
    expect(billingConfig.paymentMethods).toEqual(["card"]);
  });

  it("every configured method has a path for desktop and for phone", () => {
    const paths = new Map(PAYMENT_PATHS.map((p) => [p.method, p]));
    for (const m of billingConfig.paymentMethods) {
      const p = paths.get(m);
      expect(p, `${m} is offered at checkout but has no payment path in tests/e2e/payment-paths.ts`).toBeDefined();
      expect(p!.devices.desktop.length).toBeGreaterThan(20);
      expect(p!.devices.phone.length).toBeGreaterThan(20);
    }
  });

  it("a method added without its path fails (the check above, run on a planted list)", () => {
    const planted = [...billingConfig.paymentMethods, "paypal"];
    const known = new Set(PAYMENT_PATHS.map((p) => p.method));
    expect(planted.filter((m) => !known.has(m))).toEqual(["paypal"]);
  });
});
