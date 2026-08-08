#!/usr/bin/env node
// Flag flipper for the both-states CI matrix (capability-model-spec R3).
//
// This is the ONLY sanctioned mechanism for turning a flag off: codegen that
// rewrites the config file IN A THROWAWAY CI CHECKOUT, before the suite runs.
// It is never run against a deployed artifact, and a flag is never resolved
// from a runtime environment variable (an env-var auth/billing kill-switch in
// production is a security defect — see config/kernel.ts).
//
// Usage:
//   node scripts/set-flag.mjs --flag <name> --state on|off
//
//   • capability flags (payments, booking, comms) → rewrites config/capabilities.ts
//   • kernel flags (auth, subscription_billing, settings, nav) → rewrites config/kernel.ts
//   • the per-app switch `subscription_active` → rewrites config/billing.ts
//
// subscription_active is NOT a kernel flag and NOT a capability flag: it is the
// per-app ACTIVE state of a kernel part (capability-model-spec §2.1). The kernel
// part stays BUILT IN either way; this decides whether the app SELLS a
// subscription. Unlike the kernel flags it IS written by a real build path — the
// scaffold sets it false for a commission that declared no subscription — so
// this flipper serves the both-states matrix, not a throwaway checkout only.
//
// The edit is a single-line, whitespace-tolerant boolean replacement inside the
// relevant record literal. It asserts the flag exists and that the value
// actually changed shape (fails loudly rather than silently no-op'ing), so a
// renamed flag can never leave the matrix testing nothing.

import { readFileSync, writeFileSync } from "node:fs";

const CAPABILITY_FLAGS = new Set(["payments", "booking", "comms"]);
const KERNEL_FLAGS = new Set(["auth", "subscription_billing", "settings", "nav"]);
// Per-app ACTIVE switches: flag name → { file, record, key }. Each names a
// boolean inside a config record, flipped by the same setInRecord rewrite.
const PER_APP_SWITCHES = {
  subscription_active: {
    file: "config/billing.ts",
    record: "billingConfig",
    key: "subscriptionActive",
  },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--flag") args.flag = argv[++i];
    else if (argv[i] === "--state") args.state = argv[++i];
  }
  return args;
}

function fail(msg) {
  console.error(`::error::set-flag: ${msg}`);
  process.exit(1);
}

const { flag, state } = parseArgs(process.argv.slice(2));
if (!flag) fail("missing --flag <name>");
if (state !== "on" && state !== "off") fail("missing/invalid --state (on|off)");

const isKernel = KERNEL_FLAGS.has(flag);
const isCapability = CAPABILITY_FLAGS.has(flag);
const perApp = PER_APP_SWITCHES[flag] ?? null;
if (!isKernel && !isCapability && !perApp) {
  fail(`unknown flag "${flag}" — not a kernel, capability or per-app switch`);
}

const file = perApp
  ? perApp.file
  : isKernel
    ? "config/kernel.ts"
    : "config/capabilities.ts";
const desired = state === "on" ? "true" : "false";

const src = readFileSync(file, "utf8");

/**
 * Rewrite `<flag>: true|false,` inside ONE NAMED RECORD, not the first match in
 * the file. config/capabilities.ts declares TWO records keyed by the same flag
 * names — `enabledCapabilities` (posture) and `builtCapabilities` (does the
 * feature exist) — so a whole-file regex would silently rewrite whichever
 * happened to come first. Scoping to the named record makes the file's
 * declaration order stop being load-bearing.
 */
function setInRecord(text, record, key, value) {
  const open = new RegExp(`export const ${record}\\s*:[^=]*=\\s*\\{`);
  const opened = text.match(open);
  if (!opened) return null;
  const start = opened.index + opened[0].length;
  const end = text.indexOf("};", start);
  if (end === -1) return null;

  const block = text.slice(start, end);
  const re = new RegExp(`(\\n\\s*${key}\\s*:\\s*)(true|false)(\\s*,)`);
  const m = block.match(re);
  if (!m) return null;

  return {
    text: text.slice(0, start) + block.replace(re, `$1${value}$3`) + text.slice(end),
    previous: m[2],
  };
}

const posture = perApp
  ? setInRecord(src, perApp.record, perApp.key, desired)
  : isKernel
    ? setInRecord(src, "enabledKernel", flag, desired)
    : setInRecord(src, "enabledCapabilities", flag, desired);
if (!posture) fail(`flag "${flag}" not found as a boolean entry in ${file}`);

let next = posture.text;
const notes = [];

// Turning a capability ON also marks it BUILT for this throwaway checkout. The
// ON leg of the both-states matrix simulates the world AFTER the capability
// ships — built and on — which is the only world in which ON is a valid state
// (config/capabilities.ts · builtCapabilities). Without this the leg would
// declare a capability enabled-but-unbuilt, a posture the admission test
// forbids and no real app may ever ship. The OFF leg leaves built-ness at its
// committed value: off is valid whether or not the feature exists.
if (isCapability && state === "on") {
  const built = setInRecord(next, "builtCapabilities", flag, "true");
  if (!built) {
    fail(`capability "${flag}" has no builtCapabilities entry in ${file}`);
  }
  next = built.text;
  notes.push(`builtCapabilities.${flag} ${built.previous} -> true`);
}

writeFileSync(file, next, "utf8");

console.log(
  `set-flag: ${file} ${flag} ${posture.previous} -> ${desired} (state=${state})` +
    (posture.previous === desired ? " [already at target]" : "") +
    (notes.length ? ` · ${notes.join(", ")}` : ""),
);
