// Capability ADMISSION tests (capability-model-spec §3 R1/R4/R5 + §4 standing
// rule, step 10 — final reconciliation). Machine-checks the model's admission
// invariants for EVERY declared capability flag, so "no flag, not done" and the
// legacy-safe naming rule are CI GATES, not just prose. A new capability flag
// added without full wiring — or named after an entity/archetype — fails here.
//
// The BOTH-STATES behaviour (OFF ⇒ 404 / nav-absent / settings-inert; ON ⇒
// works) is proven per-posture in capability-both-states.test.ts. THIS suite is
// posture-independent: it audits the declarations and the enforcement
// scaffolding themselves. Kernel switches (config/kernel.ts) are structural and
// out of scope here — they carry their own always-ON invariants in the
// both-states suite's kernel block.

import { describe, it, expect } from "vitest";
import { enabledCapabilities, type CapabilityFlag } from "@/config/capabilities";
import { isKernelFlag } from "@/config/kernel";
import { CAPABILITY_ROUTES } from "@/lib/capabilities/routes";
import { CAPABILITY_NAV } from "@/lib/nav/primary-nav";
import { ALL_DEFINITIONS } from "@/lib/settings/registry";

const CAPABILITY_FLAGS = Object.keys(enabledCapabilities) as CapabilityFlag[];

// Legacy-safe naming rule (capability-model-spec §3 admission test): a flag
// names a CAPABILITY — a verb the app DOES (book, pay, message, notify) — never
// an ARCHETYPE or ENTITY — a noun the app HAS (dog, student, invoice, client).
// An entity flag couples the shared core to one app's domain (the K9Coach "dog"
// case this rule was written to forbid). The full verb-not-noun determination is
// a review-time admission test; this blocklist mechanically catches the specific
// failure mode — an entity/archetype noun leaking in as a flag name.
const ENTITY_NOUN_BLOCKLIST = [
  "dog", "dogs", "pet", "pets", "student", "students", "pupil", "pupils",
  "client", "clients", "invoice", "invoices", "appointment", "appointments",
  "member", "members", "patient", "patients", "customer", "customers",
  "order", "orders", "product", "products", "user", "users",
  "trainer", "trainers", "dossier", "record", "records",
];

describe("capability admission — legacy-safe naming (capability/verb, not entity/noun)", () => {
  for (const flag of CAPABILITY_FLAGS) {
    it(`${flag} names a capability, not an archetype/entity`, () => {
      const lower = flag.toLowerCase();
      const segments = lower.split(/[_-]/);
      const hit = ENTITY_NOUN_BLOCKLIST.find(
        (noun) => lower === noun || segments.includes(noun),
      );
      expect(
        hit,
        `capability flag "${flag}" reads like the entity/archetype noun "${hit}" — ` +
          `flags name what the app DOES (book/pay/message), not what it HAS`,
      ).toBeUndefined();
    });
  }
});

describe("capability admission — no flag, not done (R1/R2/R5 wiring present for every flag)", () => {
  for (const flag of CAPABILITY_FLAGS) {
    it(`${flag}: declared, has route prefixes (R2), nav entries, and ≥1 registered setting (R5)`, () => {
      // R1 — declared with a boolean posture.
      expect(typeof enabledCapabilities[flag]).toBe("boolean");
      // R2 — ≥1 route prefix so an OFF request has something to 404.
      expect(CAPABILITY_ROUTES[flag]?.length ?? 0).toBeGreaterThan(0);
      // Nav — registered (filtered by flag at render).
      expect(CAPABILITY_NAV[flag]?.length ?? 0).toBeGreaterThan(0);
      // R5 — owns ≥1 setting definition, so it appears in the registry manifest.
      const owned = ALL_DEFINITIONS.filter((d) => d.requiresFlag === flag);
      expect(owned.length).toBeGreaterThan(0);
    });
  }
});

describe("capability admission — registries cover exactly the declared capability set", () => {
  it("CAPABILITY_ROUTES and CAPABILITY_NAV key sets equal enabledCapabilities (no orphan, no gap)", () => {
    const declared = new Set<string>(CAPABILITY_FLAGS);
    expect(new Set(Object.keys(CAPABILITY_ROUTES))).toEqual(declared);
    expect(new Set(Object.keys(CAPABILITY_NAV))).toEqual(declared);
  });

  it("every capability nav href sits under that capability's own route prefix (nav↔route consistency)", () => {
    for (const flag of CAPABILITY_FLAGS) {
      for (const item of CAPABILITY_NAV[flag]) {
        const covered = CAPABILITY_ROUTES[flag].some(
          (prefix) => item.href === prefix || item.href.startsWith(prefix + "/"),
        );
        expect(covered, `nav "${item.href}" is not under a ${flag} route prefix`).toBe(true);
      }
    }
  });

  it("no settings definition requires an unknown flag (capability or kernel only)", () => {
    const capabilitySet = new Set<string>(CAPABILITY_FLAGS);
    for (const d of ALL_DEFINITIONS) {
      if (!d.requiresFlag) continue; // core definition — always on
      const known = capabilitySet.has(d.requiresFlag) || isKernelFlag(d.requiresFlag);
      expect(
        known,
        `setting "${d.key}" requires unknown flag "${d.requiresFlag}" (neither a capability nor a kernel flag)`,
      ).toBe(true);
    }
  });
});
