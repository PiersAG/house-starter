// The LIVE_EVAL evaluator allowlist (ADR-026 D4; app-business-core #369 —
// "k9 CI runs APP_LIFECYCLE_STATE=LAUNCHED so E2E never exercises the LIVE_EVAL
// allowlist branch. Confirm middleware unit tests assert the 403 path, or add a
// test.").
//
// The e2e suites run at LAUNCHED, so this file is where the LIVE_EVAL branch is
// exercised: every lifecycle state through lib/live-eval.ts decideAccess (the
// function the middleware calls), and the middleware's own source checked to
// turn a refusal into a 403 carrying the reason — for a protected route only,
// after the sign-in check.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentLifecycleState, decideAccess, effectiveAllowlist } from "@/lib/live-eval";

const KEYS = ["APP_LIFECYCLE_STATE", "EVALUATOR_ALLOWLIST", "CEO_EMAIL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function env(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("LIVE_EVAL: only the allowlist (and the CEO) pass", () => {
  it("refuses an empty allowlist, fail-closed", () => {
    env({ APP_LIFECYCLE_STATE: "LIVE_EVAL" });
    expect(decideAccess("someone@example.com")).toEqual({ allow: false, reason: "live-eval-empty-allowlist" });
  });

  it("refuses an address not on the allowlist", () => {
    env({ APP_LIFECYCLE_STATE: "LIVE_EVAL", EVALUATOR_ALLOWLIST: "tester@example.com" });
    expect(decideAccess("stranger@example.com")).toEqual({ allow: false, reason: "not-on-evaluator-allowlist" });
  });

  it("lets an allowlisted address in, whatever its case and spacing", () => {
    env({ APP_LIFECYCLE_STATE: "LIVE_EVAL", EVALUATOR_ALLOWLIST: " Tester@Example.com , other@example.com" });
    expect(decideAccess("  tester@EXAMPLE.com ")).toEqual({ allow: true });
    expect(decideAccess("other@example.com")).toEqual({ allow: true });
  });

  it("always lets the CEO in, even with no allowlist", () => {
    env({ APP_LIFECYCLE_STATE: "LIVE_EVAL", CEO_EMAIL: "ceo@example.com" });
    expect(effectiveAllowlist()).toEqual(["ceo@example.com"]);
    expect(decideAccess("CEO@example.com")).toEqual({ allow: true });
    expect(decideAccess("someone@example.com")).toEqual({ allow: false, reason: "not-on-evaluator-allowlist" });
  });

  it("refuses a session with no email", () => {
    env({ APP_LIFECYCLE_STATE: "LIVE_EVAL", EVALUATOR_ALLOWLIST: "tester@example.com" });
    expect(decideAccess(null)).toEqual({ allow: false, reason: "no-authenticated-email" });
    expect(decideAccess("  ")).toEqual({ allow: false, reason: "no-authenticated-email" });
  });

  it("is the state when APP_LIFECYCLE_STATE is unset or unknown (never open by default)", () => {
    env({});
    expect(currentLifecycleState()).toBe("LIVE_EVAL");
    expect(decideAccess("someone@example.com")).toMatchObject({ allow: false });
    env({ APP_LIFECYCLE_STATE: "open-please" });
    expect(currentLifecycleState()).toBe("LIVE_EVAL");
  });
});

describe("the other states", () => {
  it("LAUNCHED lets any signed-in user in, and no-one without an email", () => {
    env({ APP_LIFECYCLE_STATE: "launched" });
    expect(decideAccess("anyone@example.com")).toEqual({ allow: true });
    expect(decideAccess(null)).toEqual({ allow: false, reason: "no-authenticated-email" });
  });

  it("LIVE_OPEN applies no allowlist", () => {
    env({ APP_LIFECYCLE_STATE: "LIVE_OPEN" });
    expect(decideAccess("anyone@example.com")).toEqual({ allow: true });
  });
});

describe("the middleware turns a refusal into a 403 (the e2e suites never reach it)", () => {
  const source = readFileSync(join(__dirname, "..", "..", "middleware.ts"), "utf8");
  const block = source.slice(source.indexOf("ADR-026 D4"), source.indexOf("const requestHeaders = new Headers"));

  it("calls decideAccess for a signed-in request to a protected route", () => {
    expect(block).toMatch(/if \(isProtected && req\.auth\)/);
    expect(block).toMatch(/decideAccess\(email\)/);
  });

  it("answers 403 with the reason and the state, and does not fall through", () => {
    expect(block).toMatch(/if \(!decision\.allow\)/);
    expect(block).toMatch(/reason:\s+decision\.reason/);
    expect(block).toMatch(/lifecycle_state:\s+state/);
    expect(block).toMatch(/\{ status: 403 \}/);
    expect(block).toMatch(/return finish\(/);
  });
});
