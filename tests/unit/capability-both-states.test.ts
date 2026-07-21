// Both-states matrix assertions (capability-model-spec R3). This suite is
// FLAG-AWARE: it reads the compiled-in flag posture and asserts the behaviour
// that posture requires. The CI `capability-matrix` job runs it once per
// capability flag per state (ON and OFF), rewriting config/capabilities.ts with
// scripts/set-flag.mjs before each run — so the same assertions prove BOTH
// states, not just the default one.
//
// What is proven per capability, per state:
//   • settings visibility — OFF hides every definition that requires the flag;
//     ON shows them.
//   • settings-API 404 (step 1 substrate) — every setting key a capability owns
//     is 404'd on PUT/DELETE /api/settings/<key> when the flag is off, via the
//     shared guard the route calls (requireCapabilityForSettingKey). This is a
//     REAL 404 Response, not a placeholder — the R2 gap the audit named on the
//     settings write path, now closed.
//   • nav gating — a capability-flagged nav item shows iff its flag is on,
//     through the same predicate AppNav filters with (isCapabilityEnabled).
//
// Dedicated capability ENDPOINTS (e.g. a future /api/payments/*) do not exist
// yet; their request-level 404 proof attaches per-feature in steps 3–9 as those
// routes are built. The settings-API surface above is gated for real now.
// End-to-end wiring of the route handler itself is proven in
// tests/unit/settings-api.test.ts (it invokes the real PUT/DELETE handler).

import { describe, it, expect } from "vitest";
import { ALL_DEFINITIONS } from "@/lib/settings/registry";
import { visibleDefinitions } from "@/lib/settings/service";
import { isCapabilityEnabled } from "@/lib/capabilities/flags";
import { requireCapabilityForSettingKey } from "@/lib/capabilities/guard";
import {
  enabledCapabilities,
  isFlagEnabled,
  type CapabilityFlag,
} from "@/config/capabilities";
import { enabledKernel } from "@/config/kernel";

const CAPABILITY_FLAGS: CapabilityFlag[] = ["payments", "booking", "comms"];

/** The setting keys a capability owns — its gated surface on the settings API. */
function settingKeysFor(flag: CapabilityFlag): string[] {
  return ALL_DEFINITIONS.filter((d) => d.requiresFlag === flag).map((d) => d.key);
}

/** Keys visible in either scope given the live flag posture. */
function visibleKeys(): Set<string> {
  return new Set(
    [...visibleDefinitions(false), ...visibleDefinitions(true)].map((d) => d.key),
  );
}

describe("capability both-states — settings visibility tracks the live flag", () => {
  for (const flag of CAPABILITY_FLAGS) {
    const declaredKeys = ALL_DEFINITIONS.filter(
      (d) => d.requiresFlag === flag,
    ).map((d) => d.key);
    const on = enabledCapabilities[flag] === true;

    it(`${flag} ${on ? "ON → its settings are visible" : "OFF → its settings are hidden"}`, () => {
      // Guard: the capability must actually own at least one definition, or the
      // matrix would be proving nothing for it.
      expect(declaredKeys.length).toBeGreaterThan(0);
      const visible = visibleKeys();
      for (const key of declaredKeys) {
        expect(visible.has(key)).toBe(on);
      }
    });
  }
});

describe("capability both-states — settings-API 404 for OFF-capability keys (real R2 enforcement)", () => {
  // The gated surface delivered by step 1: PUT/DELETE /api/settings/<key> is
  // 404'd for any key whose capability is off, via requireCapabilityForSettingKey
  // (wired into app/api/settings/[key]/route.ts). Asserted against the shared
  // substrate the route calls, in BOTH states — this is the R2 gap the audit
  // named, now closed. NOT a placeholder: `denied` is a real 404 Response.
  for (const flag of CAPABILITY_FLAGS) {
    const keys = settingKeysFor(flag);
    const on = enabledCapabilities[flag] === true;

    it(`${flag} ${on ? "ON → its setting keys are writable (guard allows)" : "OFF → each setting key 404s on the settings API"}`, () => {
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        const denied = requireCapabilityForSettingKey(key);
        if (on) {
          expect(denied).toBeNull();
        } else {
          expect(denied).not.toBeNull();
          expect(denied?.status).toBe(404);
        }
      }
    });
  }
});

describe("capability both-states — nav gating predicate tracks the flag", () => {
  // AppNav filters its links by isCapabilityEnabled(link.requiresFlag). This is
  // that exact predicate — a capability-flagged nav item shows iff its flag is
  // on. (Additive to the 404; a hidden link is polish, the guard is enforcement.)
  for (const flag of CAPABILITY_FLAGS) {
    const on = enabledCapabilities[flag] === true;
    it(`${flag}: a nav item requiring it is ${on ? "shown" : "hidden"}`, () => {
      expect(isCapabilityEnabled(flag)).toBe(on);
    });
  }
});

describe("kernel invariant — subscription_billing carries the grace setting", () => {
  it("billing.subscription_grace_days visibility tracks the subscription_billing kernel flag", () => {
    const graceVisible = visibleKeys().has("billing.subscription_grace_days");
    // In a real build the kernel flag is on and the setting is visible. Inside a
    // throwaway checkout that flipped it off, both go false together — proving it
    // is a real switch, not unconditional behaviour.
    expect(graceVisible).toBe(enabledKernel.subscription_billing === true);
    expect(isFlagEnabled("subscription_billing")).toBe(
      enabledKernel.subscription_billing === true,
    );
  });
});
