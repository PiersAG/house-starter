// The placeholder price never reaches a live price (app-business-core #374, CEO
// ruling 2026-11-03): with `pricePlaceholder: true` in config/billing.ts, a live Stripe
// key is refused with a plain reason; test keys work as usual, so the build and its
// previews are never blocked for want of a price.

import { afterEach, describe, expect, it } from "vitest";
import { billingConfig } from "@/config/billing";
import { checkPlaceholderPrice, isLiveStripeKey } from "@/lib/billing/placeholder";
import { getStripe, __resetStripeForTests } from "@/lib/billing/stripe";

// Made-up keys, built at run time so no key-shaped value sits in this file for the
// secret scan to find.
const fakeKey = (kind: "rk" | "sk", mode: "live" | "test", tail = "x") =>
  [kind, mode, tail].join("_");

describe("the placeholder price", () => {
  const saved = { key: process.env.STRIPE_SECRET_KEY, env: process.env.VERCEL_ENV,
                  flag: billingConfig.pricePlaceholder };
  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = saved.key;
    if (saved.env === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = saved.env;
    billingConfig.pricePlaceholder = saved.flag;
    __resetStripeForTests();
  });

  it("the template carries no placeholder", () => {
    expect(billingConfig.pricePlaceholder).toBe(false);
  });

  it("tells live keys from test keys", () => {
    expect(isLiveStripeKey(fakeKey("rk", "live"))).toBe(true);
    expect(isLiveStripeKey(fakeKey("sk", "live"))).toBe(true);
    expect(isLiveStripeKey(fakeKey("rk", "test"))).toBe(false);
    expect(isLiveStripeKey(fakeKey("sk", "test"))).toBe(false);
  });

  it("refuses a live key on a placeholder, without naming the key", () => {
    const key = fakeKey("rk", "live", "secretvalue");
    const r = checkPlaceholderPrice(key, true);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/PLACEHOLDER/);
    expect(!r.ok && r.reason).toMatch(/set_app_price\.py/);
    expect(!r.ok && r.reason).not.toContain(key);
  });

  it("allows a test key on a placeholder, and any key on a real price", () => {
    expect(checkPlaceholderPrice(fakeKey("rk", "test"), true)).toEqual({ ok: true });
    expect(checkPlaceholderPrice(fakeKey("rk", "live"), false)).toEqual({ ok: true });
  });

  it("getStripe() refuses a live key in production while the price is the placeholder", () => {
    process.env.VERCEL_ENV = "production";
    process.env.STRIPE_SECRET_KEY = fakeKey("rk", "live", "dummy");
    billingConfig.pricePlaceholder = true;
    __resetStripeForTests();
    expect(() => getStripe()).toThrow(/PLACEHOLDER/);
    billingConfig.pricePlaceholder = false;
    __resetStripeForTests();
    expect(getStripe()).toBeDefined();
  });

  it("getStripe() keeps test mode working on a placeholder", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.STRIPE_SECRET_KEY = fakeKey("sk", "test", "dummy");
    billingConfig.pricePlaceholder = true;
    __resetStripeForTests();
    expect(getStripe()).toBeDefined();
  });
});
