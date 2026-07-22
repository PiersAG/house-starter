// Both-states matrix assertions (capability-model-spec R3). This suite is
// FLAG-AWARE: it reads the compiled-in flag posture and asserts the behaviour
// that posture requires. The CI `capability-matrix` job runs it once per
// capability flag per state (ON and OFF), rewriting config/capabilities.ts with
// scripts/set-flag.mjs before each run — so the same assertions prove BOTH
// states, not just the default one.
//
// What is proven per capability, per state:
//   • settings visibility — OFF hides every definition that requires the flag.
//   • settings-API 404 (step 1) — each owned key is 404'd on PUT/DELETE
//     /api/settings/<key> when off, via the shared guard the route calls.
//   • settings READ/WRITE/SEED inertness (step 3) — with a real migrated DB:
//     an OFF capability's key cannot be read (resolveSetting throws), written
//     (setOwnerValue throws), or seeded (absent from setting_definitions). ON →
//     all three work. This closes R2 beyond the write API, at every surface the
//     substrate reaches.
//   • nav filtering (steps 4, 7–9) — a capability's REGISTERED nav entries
//     (CAPABILITY_NAV, now part of PRIMARY_NAV) are dropped by visibleNavItems
//     (the one filter every nav surface uses) when off.
//   • route/API 404 (steps 7–9) — a request under a capability's REGISTERED
//     route prefix (CAPABILITY_ROUTES) is 404'd when off, via the same predicate
//     the edge middleware runs (isPathDisabledByCapability) and the per-handler
//     guard returns (requireCapabilityForPath). This REPLACES the step-2
//     empty-registry placeholder: the OFF-leg 404 is now real enforcement over
//     each capability's whole route subtree (current + not-yet-built paths).
//
// The features themselves are still unbuilt — CAPABILITY_ROUTES/CAPABILITY_NAV
// are the enforcement SCAFFOLDING each attaches to when built (see routes.ts).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import type { AppDatabase } from "@/lib/users";
import { ALL_DEFINITIONS } from "@/lib/settings/registry";
import { visibleDefinitions } from "@/lib/settings/service";
import { resolveSetting } from "@/lib/settings/resolver";
import { setOwnerValue } from "@/lib/settings/values";
import { CapabilityDisabledError } from "@/lib/settings/errors";
import { requireCapabilityForSettingKey, requireCapabilityForPath } from "@/lib/capabilities/guard";
import { visibleNavItems, PRIMARY_NAV } from "@/lib/nav/primary-nav";
import {
  CAPABILITY_ROUTES,
  capabilityForPath,
  isPathDisabledByCapability,
} from "@/lib/capabilities/routes";
import {
  enabledCapabilities,
  isFlagEnabled,
  type CapabilityFlag,
} from "@/config/capabilities";
import { enabledKernel, isKernelFlag, isKernelEnabled, type KernelFlag } from "@/config/kernel";

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

describe("capability both-states — settings read/write/seed inertness (step 3, real DB)", () => {
  let client: Client;
  let db: AppDatabase;

  beforeEach(async () => {
    client = createMigrationDatabase(":memory:"); // runMigrations also seeds
    await runMigrations(client);
    db = drizzle(client) as AppDatabase;
  });
  afterEach(() => client.close());

  for (const flag of CAPABILITY_FLAGS) {
    const keys = settingKeysFor(flag);
    const on = enabledCapabilities[flag] === true;
    const sample = keys[0];

    it(`${flag} ${on ? "ON → its keys read/write/seed" : "OFF → its keys are inert (read/write throw, not seeded)"}`, async () => {
      expect(sample).toBeTruthy();
      // SEED: present in the catalogue iff on.
      const seeded = await client.execute(
        `SELECT COUNT(*) AS n FROM setting_definitions WHERE key = '${sample}';`,
      );
      expect(Number((seeded.rows[0] as Record<string, unknown>).n)).toBe(on ? 1 : 0);

      if (on) {
        // READ resolves (factory default); WRITE is accepted (values layer does
        // not type-check — that is the API validator's job, tested elsewhere).
        await expect(resolveSetting(db, sample)).resolves.toBeDefined();
        await expect(setOwnerValue(db, sample, "x")).resolves.toBeUndefined();
      } else {
        // READ and WRITE both refuse — the key is absent, not merely hidden.
        await expect(resolveSetting(db, sample)).rejects.toBeInstanceOf(
          CapabilityDisabledError,
        );
        await expect(setOwnerValue(db, sample, "x")).rejects.toBeInstanceOf(
          CapabilityDisabledError,
        );
      }
    });
  }
});

describe("capability both-states — route/API 404 for OFF-capability prefixes (steps 7-9, real R2)", () => {
  // Replaces the step-2 empty-registry placeholder with real enforcement. Each
  // capability declares its route prefixes in CAPABILITY_ROUTES; a request under
  // an OFF capability's prefix is 404'd via the same predicate the edge
  // middleware runs (isPathDisabledByCapability) and the per-handler guard
  // returns (requireCapabilityForPath — a real 404 Response). Proven in BOTH
  // states for every capability, over its whole subtree (a nested sample path).
  for (const flag of CAPABILITY_FLAGS) {
    const prefixes = CAPABILITY_ROUTES[flag];
    const on = enabledCapabilities[flag] === true;

    it(`${flag} owns ≥1 route prefix; each is ${on ? "reachable (guard allows)" : "404'd over its whole subtree"}`, () => {
      expect(prefixes.length).toBeGreaterThan(0);
      for (const prefix of prefixes) {
        // The prefix and any nested path resolve to this capability.
        expect(capabilityForPath(prefix)).toBe(flag);
        const nested = `${prefix}/deep/child`;
        expect(capabilityForPath(nested)).toBe(flag);
        // Enforcement tracks the live flag, in both states.
        expect(isPathDisabledByCapability(nested)).toBe(!on);
        const denied = requireCapabilityForPath(nested);
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

describe("capability both-states — nav filtering drops OFF-capability items (steps 4, 7-9)", () => {
  // visibleNavItems is the single filter every nav/menu surface runs. Now proven
  // against each capability's REAL registered entries in PRIMARY_NAV (CAPABILITY_NAV),
  // not a synthetic item: a capability's tab appears iff its flag is on.
  for (const flag of CAPABILITY_FLAGS) {
    const on = enabledCapabilities[flag] === true;
    const owned = PRIMARY_NAV.filter((item) => item.requiresFlag === flag);

    it(`${flag} owns ≥1 nav entry; it is ${on ? "present" : "absent"} when ${on ? "on" : "off"}`, () => {
      expect(owned.length).toBeGreaterThan(0);
      const visibleHrefs = new Set(visibleNavItems(PRIMARY_NAV).map((i) => i.href));
      for (const item of owned) {
        expect(visibleHrefs.has(item.href)).toBe(on);
        // A capability's nav href must sit under its own route prefix, so nav and
        // route enforcement stay consistent (hidden AND 404'd together when off).
        expect(capabilityForPath(item.href)).toBe(flag);
      }
      expect(visibleHrefs.has("/dashboard")).toBe(true); // core always shows
    });
  }
});

describe("capability route matcher — core paths untouched, segment-boundary safe", () => {
  // Invariants that hold in every leg: the matcher never captures a core/kernel
  // path, and never false-matches a sibling that merely shares a string prefix.
  it("core/kernel paths belong to no capability and are never disabled", () => {
    for (const p of [
      "/", "/dashboard", "/dashboard/settings", "/account",
      "/login", "/signup", "/api/settings/foo", "/api/auth/session",
    ]) {
      expect(capabilityForPath(p)).toBeNull();
      expect(isPathDisabledByCapability(p)).toBe(false);
    }
  });

  it("matches only on a path-segment boundary", () => {
    for (const flag of CAPABILITY_FLAGS) {
      for (const prefix of CAPABILITY_ROUTES[flag]) {
        expect(capabilityForPath(prefix)).toBe(flag); // exact
        expect(capabilityForPath(`${prefix}/x`)).toBe(flag); // nested
        expect(capabilityForPath(`${prefix}-other`)).toBeNull(); // sibling, no false match
        expect(capabilityForPath(`${prefix}extra`)).toBeNull();
      }
    }
  });

  it("capability route prefixes are disjoint (no path owned by two capabilities)", () => {
    const seen = new Map<string, CapabilityFlag>();
    for (const flag of CAPABILITY_FLAGS) {
      for (const prefix of CAPABILITY_ROUTES[flag]) {
        for (const other of CAPABILITY_FLAGS) {
          if (other === flag) continue;
          for (const otherPrefix of CAPABILITY_ROUTES[other]) {
            expect(otherPrefix === prefix || otherPrefix.startsWith(prefix + "/")).toBe(false);
          }
        }
        expect(seen.has(prefix)).toBe(false);
        seen.set(prefix, flag);
      }
    }
  });
});

describe("kernel switches — declared, hidden, and ON (incl. auth, step 6)", () => {
  // The four kernel parts an app is not an app without. Each carries a switch so
  // OFF is a *testable* state and the kernel cannot grow un-switchable behaviour,
  // but every real build has them ON — no automated path turns one off. This is
  // the ON proof the matrix runs in every leg (kernel flags are independent of
  // the capability flag being flipped, so they stay ON throughout).
  //
  // `auth` is declared here alongside the others but deliberately has NO OFF code
  // path: auth.config.ts throws at import without AUTH_SECRET, so an auth-OFF
  // branch would be never-run dead code. We prove ON only. Note this suite never
  // imports auth.config.ts — isKernelEnabled resolves the flag from config/kernel.ts
  // alone, so the AUTH_SECRET import-time throw is not engaged.
  const KERNEL_FLAGS: KernelFlag[] = ["auth", "subscription_billing", "settings", "nav"];

  for (const flag of KERNEL_FLAGS) {
    it(`${flag}: recognised as a kernel flag, resolvable, and ON`, () => {
      expect(isKernelFlag(flag)).toBe(true);
      expect(isKernelEnabled(flag)).toBe(true);
      expect(enabledKernel[flag]).toBe(true);
      // Resolves ON through the unified capability resolver too (a kernel flag is
      // always enabled), which is how requiresFlag:"subscription_billing" settings
      // stay visible/resolvable regardless of capability posture.
      expect(isFlagEnabled(flag)).toBe(true);
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
