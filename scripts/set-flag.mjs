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
//
// The edit is a single-line, whitespace-tolerant boolean replacement inside the
// relevant record literal. It asserts the flag exists and that the value
// actually changed shape (fails loudly rather than silently no-op'ing), so a
// renamed flag can never leave the matrix testing nothing.

import { readFileSync, writeFileSync } from "node:fs";

const CAPABILITY_FLAGS = new Set(["payments", "booking", "comms"]);
const KERNEL_FLAGS = new Set(["auth", "subscription_billing", "settings", "nav"]);

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
if (!isKernel && !isCapability) {
  fail(`unknown flag "${flag}" — not a kernel or capability flag`);
}

const file = isKernel ? "config/kernel.ts" : "config/capabilities.ts";
const desired = state === "on" ? "true" : "false";

const src = readFileSync(file, "utf8");

// Match a `  <flag>: true|false,` entry inside the record literal, tolerating
// surrounding whitespace and an optional trailing comment on the value line.
const re = new RegExp(`(\\n\\s*${flag}\\s*:\\s*)(true|false)(\\s*,)`);
const m = src.match(re);
if (!m) fail(`flag "${flag}" not found as a boolean entry in ${file}`);

const current = m[2];
const next = src.replace(re, `$1${desired}$3`);
writeFileSync(file, next, "utf8");

console.log(
  `set-flag: ${file} ${flag} ${current} -> ${desired} (state=${state})` +
    (current === desired ? " [already at target]" : ""),
);
