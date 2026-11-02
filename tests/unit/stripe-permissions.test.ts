// #544 (Matt Murphy #235): production runs on a restricted Stripe key holding
// only the permissions the billing code needs. These tests hold the permission
// list (lib/billing/permissions.ts) to the code and to the setup doc, and prove
// production refuses a full-power key.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  STRIPE_PERMISSIONS,
  checkStripeKeyScope,
  stripeKeyKind,
} from "@/lib/billing/permissions";
import { getStripe, __resetStripeForTests } from "@/lib/billing/stripe";

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const SOURCES = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")];

describe("the permission list matches the code", () => {
  const calls = new Map<string, string[]>();
  for (const f of SOURCES) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const m of text.matchAll(/getStripe\(\)\s*\.\s*([A-Za-z_.\s]+?)\s*\.\s*([A-Za-z_]+)\s*\(/g)) {
      const resource = m[1].replace(/\s+/g, "");
      if (resource === "webhooks") continue; // signature check — local, no permission
      const key = `${resource}.${m[2]}`;
      calls.set(key, [...(calls.get(key) ?? []), f]);
    }
  }

  it("finds the template's Stripe calls (the scan works)", () => {
    expect([...calls.keys()].sort()).toEqual(["billingPortal.sessions.create", "checkout.sessions.create"]);
  });

  it("every Stripe call in app/, lib/ and components/ has its permission listed", () => {
    const listed = new Set(STRIPE_PERMISSIONS.map((p) => `${p.resource}.${p.call}`));
    const missing = [...calls.entries()].filter(([k]) => !listed.has(k)).map(([k, f]) => `${k} (${f.join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("no permission is listed that the code does not use", () => {
    const unused = STRIPE_PERMISSIONS.filter((p) => !calls.has(`${p.resource}.${p.call}`));
    expect(unused).toEqual([]);
  });

  it("only lib/billing/stripe.ts builds a Stripe client", () => {
    const builders = SOURCES.filter((f) => /new\s+Stripe\s*\(/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(builders).toEqual([join("lib", "billing", "stripe.ts")]);
  });

  it("the setup doc's permission table lists exactly these permissions", () => {
    const doc = readFileSync(join(ROOT, "docs/per-app-stripe-account.md"), "utf8");
    for (const p of STRIPE_PERMISSIONS) {
      expect(doc).toContain(`| ${p.permission} | ${p.access} |`);
    }
    const rows = doc.split("\n").map((l) => l.trim()).filter((l) => /^\| [A-Z][^|]* \| (Read|Write) \|/.test(l));
    expect(rows).toHaveLength(STRIPE_PERMISSIONS.length);
  });
});

describe("production refuses a full-power key", () => {
  const saved = { key: process.env.STRIPE_SECRET_KEY, env: process.env.VERCEL_ENV };
  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = saved.key;
    if (saved.env === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = saved.env;
    __resetStripeForTests();
  });

  it("tells a restricted key from a secret key", () => {
    expect(stripeKeyKind("rk_live_abc")).toBe("restricted");
    expect(stripeKeyKind("rk_test_abc")).toBe("restricted");
    expect(stripeKeyKind("sk_live_abc")).toBe("secret");
    expect(stripeKeyKind("whsec_abc")).toBe("unknown");
  });

  it("refuses sk_ and unknown keys in production, accepts rk_", () => {
    expect(checkStripeKeyScope("rk_live_x", "production")).toEqual({ ok: true });
    const refused = checkStripeKeyScope("sk_live_x", "production");
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/full-power secret key.*restricted key/);
    expect(!refused.ok && refused.reason).not.toContain("sk_live_x");
    expect(checkStripeKeyScope("nonsense", "production").ok).toBe(false);
  });

  it("previews, CI and local runs keep the test key", () => {
    expect(checkStripeKeyScope("sk_test_x", "preview")).toEqual({ ok: true });
    expect(checkStripeKeyScope("sk_test_x", undefined)).toEqual({ ok: true });
  });

  it("getStripe() throws in production on a secret key and builds a client on a restricted one", () => {
    process.env.VERCEL_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    __resetStripeForTests();
    expect(() => getStripe()).toThrow(/restricted key/);
    process.env.STRIPE_SECRET_KEY = "rk_test_dummy";
    __resetStripeForTests();
    expect(getStripe()).toBeDefined();
  });
});
