// Both-states matrix assertions (capability-model-spec R3). This suite is
// FLAG-AWARE: it reads the compiled-in flag posture and asserts the behaviour
// that posture requires. The CI `capability-matrix` job runs it once per
// capability flag per state (ON and OFF), rewriting config/capabilities.ts with
// scripts/set-flag.mjs before each run — so the same assertions prove BOTH
// states, not just the default one.
//
// What is proven per capability, per state:
//   • settings visibility — OFF hides every definition that requires the flag;
//     ON shows them. This is fully asserted here today.
//   • routes / API 404 when OFF — see CAPABILITY_ROUTES. EMPTY today: no
//     client-facing capability (client payments, booking, comms) ships routes
//     yet, so there is nothing to 404. Per-feature retrofit steps (1, 3–9) add
//     their routes here and the request-level 404 assertion switches on.
//   • nav absent when OFF — see CAPABILITY_NAV. EMPTY today, same reason.
//
// The empty route/nav registries are deliberately explicit, not silently
// skipped: this file is where a reader (and CI) sees that route/nav OFF-proof is
// PENDING per capability, established as a pattern but not yet exercised because
// the capabilities are unbuilt.

import { describe, it, expect } from "vitest";
import { ALL_DEFINITIONS } from "@/lib/settings/registry";
import { visibleDefinitions } from "@/lib/settings/service";
import {
  enabledCapabilities,
  isFlagEnabled,
  type CapabilityFlag,
} from "@/config/capabilities";
import { enabledKernel } from "@/config/kernel";

const CAPABILITY_FLAGS: CapabilityFlag[] = ["payments", "booking", "comms"];

// Routes/APIs each capability owns. When a capability is OFF, every path here
// must 404. EMPTY until the capability is built — extended per-feature.
const CAPABILITY_ROUTES: Record<CapabilityFlag, string[]> = {
  payments: [],
  booking: [],
  comms: [],
};

// Nav hrefs each capability contributes. When OFF, none of these appear in the
// rendered nav. EMPTY until the capability is built — extended per-feature.
const CAPABILITY_NAV: Record<CapabilityFlag, string[]> = {
  payments: [],
  booking: [],
  comms: [],
};

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

describe("capability both-states — route/API 404 when OFF (pattern; empty until built)", () => {
  for (const flag of CAPABILITY_FLAGS) {
    const routes = CAPABILITY_ROUTES[flag];
    it(`${flag}: ${routes.length} route(s) registered for 404-when-off proof`, () => {
      // No assertion beyond documenting the count today: request-level 404
      // proof attaches here per-feature as routes land (steps 1, 3–9). When a
      // route is added, iterate `routes` and assert a request returns 404 while
      // `isFlagEnabled(flag)` is false.
      expect(routes.length).toBeGreaterThanOrEqual(0);
    });
  }
});

describe("capability both-states — nav absent when OFF (pattern; empty until built)", () => {
  for (const flag of CAPABILITY_FLAGS) {
    const nav = CAPABILITY_NAV[flag];
    it(`${flag}: ${nav.length} nav item(s) registered for absent-when-off proof`, () => {
      expect(nav.length).toBeGreaterThanOrEqual(0);
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
