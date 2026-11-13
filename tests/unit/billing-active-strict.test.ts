// app-business-core #743 (second-platform cross-check, Dispatch BG): subscription billing
// is ACTIVE only when both switches are exactly `true` —
//   isKernelEnabled("subscription_billing") === true && billingConfig.subscriptionActive === true
// This file holds the cases that pass with today's check; the cases where a truthy
// value that is not `true` must never switch billing on arrive with the strict check
// itself (a gate-protected edit the CEO script applies). Driven both ways: every pairing of the two switches, with the path
// guard (isPathDisabledByBilling) following the same answer.

import { afterEach, describe, expect, it, vi } from "vitest";

async function load(kernel: unknown, subscriptionActive: unknown) {
  vi.resetModules();
  vi.doMock("@/config/kernel", async (orig) => {
    const real = (await orig()) as Record<string, unknown>;
    return {
      ...real,
      isKernelEnabled: (flag: string) => (flag === "subscription_billing" ? kernel : true),
    };
  });
  vi.doMock("@/config/billing", async (orig) => {
    const real = (await orig()) as { billingConfig: Record<string, unknown> };
    return { ...real, billingConfig: { ...real.billingConfig, subscriptionActive } };
  });
  return import("@/lib/billing/routes");
}

afterEach(() => {
  vi.doUnmock("@/config/kernel");
  vi.doUnmock("@/config/billing");
  vi.resetModules();
});

describe("subscription billing is active only on two exact trues", () => {
  it("is active when the kernel part and the app's switch are both true", async () => {
    const r = await load(true, true);
    expect(r.isSubscriptionBillingActive()).toBe(true);
    expect(r.isPathDisabledByBilling("/api/billing/checkout")).toBe(false);
  });

  it.each([
    ["kernel off", false, true],
    ["app switch off", true, false],
    ["both off", false, false],
  ])("is inactive with %s", async (_name, kernel, sub) => {
    const r = await load(kernel, sub);
    expect(r.isSubscriptionBillingActive()).toBe(false);
    expect(r.isPathDisabledByBilling("/api/billing/checkout")).toBe(true);
  });

  it("a non-billing path is never disabled, whatever the switches", async () => {
    const r = await load(1, "true");
    expect(r.isPathDisabledByBilling("/dashboard")).toBe(false);
  });
});
