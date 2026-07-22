#!/usr/bin/env node
// Fail-closed billing-price guard (root fix for the stub-price checkout 500).
//
// config/billing.ts ships a STUB price id ("price_stub_replace_me") in the
// house-starter template — deliberately, so template CI stays truthful without
// ever talking to Stripe. But that stub must NEVER survive into a generated app
// repo: /api/billing/checkout passes priceIds.default straight to Stripe, and a
// stub id makes every Subscribe click 500 with "No such price" (the K9Coach
// /reactivate incident, 2026-07-22). Commissioning now creates a real price at
// scaffold (agents/build/provision_stripe_price.py); this guard is the CI
// backstop that fails loudly if any app ever ships without one.
//
// Two modes:
//   (default)      APP repos — FAIL if any priceIds value is a stub, or if
//                  priceIds.default is not a real Stripe price id (price_…).
//   --expect-stub  the TEMPLATE's own CI — assert the stub IS still present, so
//                  a real price id can never be accidentally hardcoded into the
//                  template (which every app inherits).
//
// The house-starter CI selects the mode by repo identity (github.repository);
// every generated app repo runs the default, fail-closed mode.

import { readFileSync } from "node:fs";

const STUB = "price_stub_replace_me";
const CONFIG = "config/billing.ts";
const expectStub = process.argv.includes("--expect-stub");

function fail(msg) {
  console.error(`::error::check-billing-configured: ${msg}`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(CONFIG, "utf8");
} catch {
  fail(`${CONFIG} not found — cannot verify the subscription price is configured.`);
}

// Extract the priceIds record and its string values. Whitespace-tolerant; does
// not depend on formatting. Fails loudly if the record can't be located rather
// than passing vacuously.
const block = text.match(/priceIds\s*:\s*\{([\s\S]*?)\}/);
if (!block) {
  fail(`could not locate a priceIds record in ${CONFIG}.`);
}
const values = [...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
const defaultMatch = block[1].match(/\bdefault\s*:\s*["']([^"']+)["']/);
if (!defaultMatch) {
  fail(`priceIds has no 'default' entry in ${CONFIG}.`);
}
const defaultId = defaultMatch[1];

if (expectStub) {
  if (defaultId !== STUB) {
    fail(
      `template guard: expected priceIds.default to be the stub "${STUB}", but ` +
        `found "${defaultId}". A real price id must never be hardcoded into the ` +
        `template — every generated app inherits it.`,
    );
  }
  console.log(`OK (template): priceIds.default is the stub "${STUB}" as expected.`);
  process.exit(0);
}

// App-repo mode: fail-closed.
const stubbed = values.filter((v) => v === STUB || v.includes("_replace_me") || v.includes("stub"));
if (stubbed.length > 0) {
  fail(
    `unresolved stub price id(s) in ${CONFIG}: ${stubbed.map((v) => `"${v}"`).join(", ")}. ` +
      `This app must ship a REAL Stripe price — run provisioning ` +
      `(provision-app-billing.yml / provision_stripe_price.py). Shipping the stub ` +
      `makes /api/billing/checkout 500 on Stripe "No such price".`,
  );
}
if (!/^price_[A-Za-z0-9]+$/.test(defaultId)) {
  fail(
    `priceIds.default ("${defaultId}") is not a valid Stripe price id (expected price_…). ` +
      `Refusing to ship an app whose checkout price is not a real Stripe price.`,
  );
}
console.log(`OK: priceIds.default is a real Stripe price id ("${defaultId}"); no stubs present.`);
