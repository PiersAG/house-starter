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
//   • nav filtering (step 4) — a capability-flagged nav item is dropped by
//     visibleNavItems (the one filter every nav surface uses) when off.
//
// Dedicated capability ENDPOINTS (e.g. a future /api/payments/*) do not exist
// yet; their request-level 404 proof attaches per-feature in steps 5–9. The
// route handler's own wiring is proven in tests/unit/settings-api.test.ts.

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
import { requireCapabilityForSettingKey } from "@/lib/capabilities/guard";
import { visibleNavItems, type NavItem } from "@/lib/nav/primary-nav";
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

describe("capability both-states — nav filtering drops OFF-capability items (step 4)", () => {
  // visibleNavItems is the single filter every nav/menu surface runs. A
  // capability-flagged entry appears iff its flag is on — proven here against
  // the real filter, not just the predicate.
  for (const flag of CAPABILITY_FLAGS) {
    const on = enabledCapabilities[flag] === true;
    const item: NavItem = { href: `/x/${flag}`, label: flag, requiresFlag: flag };

    it(`${flag}: a nav item requiring it is ${on ? "present" : "absent"}`, () => {
      const visible = visibleNavItems([{ href: "/", label: "Home" }, item]);
      expect(visible).toContainEqual({ href: "/", label: "Home" }); // core always shows
      expect(visible.includes(item)).toBe(on);
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
