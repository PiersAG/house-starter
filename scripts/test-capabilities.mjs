#!/usr/bin/env node
// The capability matrix as one named command (app-business-core #380):
//
//   npm run test:capabilities
//
// Every capability, ON and OFF, through the R1-R5 checks (wiki/specs/capability-model-spec.md):
// each flag is flipped with scripts/set-flag.mjs, the capability tests run, and the file
// is put back exactly as it was, whatever happens. The clean-up gate
// (app-business-core wiki/cleanup/scripts/verify.sh) runs this on every zone, because
// flag-gated code reads as dead code to every tool. CI's `capability-matrix` job runs the
// same flips with the whole suite; this is the quick form for a working folder.
// Exit 0 only when every leg passed.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export const CONFIG = "config/capabilities.ts";
export const FLAGS = ["payments", "booking", "comms"];
export const STATES = ["on", "off"];
// R1, R2, R4 and R5: capability-admission. R2 and R3: capability-both-states. The two
// others read the same posture, at the settings write and at the edge.
export const TESTS = [
  "tests/unit/capability-admission.test.ts",
  "tests/unit/capability-both-states.test.ts",
  "tests/unit/settings-api.test.ts",
  "tests/unit/health-route-exempt.test.ts",
];

function run(command, args) {
  return spawnSync(command, args, { stdio: "inherit", shell: false }).status === 0;
}

function main() {
  const original = readFileSync(CONFIG, "utf8");
  const restore = () => writeFileSync(CONFIG, original);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      restore();
      process.exit(1);
    });
  }
  const failed = [];
  try {
    for (const flag of FLAGS) {
      for (const state of STATES) {
        restore();
        console.log(`== capability ${flag} = ${state}`);
        const ok =
          run("node", ["scripts/set-flag.mjs", "--flag", flag, "--state", state]) &&
          run("npx", ["vitest", "run", ...TESTS]);
        if (!ok) failed.push(`${flag} = ${state}`);
      }
    }
  } finally {
    restore();
  }
  if (failed.length > 0) {
    console.error(`Capability matrix FAILED: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`Capability matrix passed: ${FLAGS.length * STATES.length} legs.`);
}

if (process.argv[1]?.endsWith("test-capabilities.mjs")) main();
