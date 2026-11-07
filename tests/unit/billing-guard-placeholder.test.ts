// scripts/check-billing-configured.mjs and the placeholder price (app-business-core
// #374, CEO ruling 2026-11-03: "the build is never blocked for want of a price").
//
//   * an app on the build's £20/month placeholder passes CI, with a warning;
//   * the template may not carry a placeholder;
//   * an app that sells nothing may not carry one either;
//   * an app built before the field existed reads as "not a placeholder".

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "scripts", "check-billing-configured.mjs");

function config(opts: { price: string; appId: string; active?: boolean; placeholder?: boolean | null }): string {
  const flag = opts.placeholder === null || opts.placeholder === undefined
    ? "" : `  pricePlaceholder: ${opts.placeholder},\n`;
  return `export const billingConfig = {
  priceIds: {
    default: "${opts.price}",
  },
  appId: "${opts.appId}",
  trialDays: 14,
  gatedRoutePrefixes: [],
  subscriptionActive: ${opts.active ?? true},
  paymentMethods: ["card"],
${flag}};
`;
}

function run(text: string, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "billing-guard-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "billing.ts"), text);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const APP = { price: "price_1ABCdef", appId: "k9coach" };
const TEMPLATE = { price: "price_stub_replace_me", appId: "app_stub_replace_me" };

describe("the billing guard and the placeholder price", () => {
  it("passes an app on the placeholder, with a warning", () => {
    const r = run(config({ ...APP, placeholder: true }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::warning::.*PLACEHOLDER/);
    expect(r.out).toMatch(/set_app_price\.py/);
  });

  it("passes a real price quietly", () => {
    const r = run(config({ ...APP, placeholder: false }));
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/::warning::/);
  });

  it("reads an app built before the field existed as not a placeholder", () => {
    const r = run(config({ ...APP, placeholder: null }));
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/placeholder/i);
  });

  it("refuses a placeholder in the template", () => {
    expect(run(config({ ...TEMPLATE, placeholder: false }), "--expect-stub").code).toBe(0);
    const r = run(config({ ...TEMPLATE, placeholder: true }), "--expect-stub");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/pricePlaceholder: true/);
  });

  it("refuses a placeholder on an app that sells nothing", () => {
    const r = run(config({ ...TEMPLATE, active: false, placeholder: true }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/sells nothing/);
  });
});
