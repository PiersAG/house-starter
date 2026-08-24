// Settings registry tests (settings-registry-spec §8 acceptance 1).
//
// Runs the resolver, value store and validation against a REAL in-memory libSQL
// database brought up by the one true migration path (lib/migrate.ts) — which
// also seeds the definitions catalogue — so what is asserted is what production
// executes (same pattern as tests/unit/billing.test.ts). Covers: four-level
// resolution fall-through, unknown-key rejection, bounds rejection,
// owner_editable=false rejection, operator-key rejection, enum validation,
// delete-reverts-to-fallthrough, flag-hidden definitions absent from the UI, and
// seed idempotency.
//
// ONE DATABASE HERE, ON PURPOSE. runMigrations applies BOTH plane DDLs, so this
// file's `stores` points the tenant and catalog handles at the same database —
// which keeps every pre-existing assertion about resolution SEMANTICS honest
// without making each one carry two connections. That deliberately cannot prove
// tenant ISOLATION, because one database cannot leak into another. The proof
// that the planes are actually separate lives in settings-planes.test.ts, which
// provisions three real databases (tenant A, tenant B, catalog) and asserts the
// exact defect this change fixes — tenant A writing a value tenant B then reads.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import type { AppDatabase } from "@/lib/users";
import {
  getSetting,
  resolveSetting,
  UnknownSettingError,
} from "@/lib/settings/resolver";
import {
  setOwnerValue,
  setClientValue,
  deleteValue,
} from "@/lib/settings/values";
import { setOperatorValue } from "@/lib/settings/operator";
import {
  validateOwnerWrite,
  validateClientWrite,
} from "@/lib/settings/validation";
import {
  buildOwnerSettingsView,
  visibleDefinitions,
} from "@/lib/settings/service";
import { ALL_DEFINITIONS } from "@/lib/settings/registry";
import { CapabilityDisabledError } from "@/lib/settings/errors";
import { isCapabilityEnabled } from "@/lib/capabilities/flags";
import { enabledCapabilities } from "@/config/capabilities";

import type { SettingsStores } from "@/lib/settings/types";

let client: Client;
let db: AppDatabase;
/** Tenant and catalog handles — the same database here; see the header note. */
let stores: SettingsStores;

async function freshDb(): Promise<{ client: Client; db: AppDatabase }> {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  return { client: c, db: drizzle(c) as AppDatabase };
}

beforeEach(async () => {
  ({ client, db } = await freshDb());
  stores = { tenant: db, catalog: db };
});

afterEach(() => {
  client.close();
});

describe("resolution fall-through (all four levels)", () => {
  it("returns the factory default when nothing is set", async () => {
    // core.client_self_registration ships false.
    const { value, source } = await resolveSetting(stores, "core.client_self_registration");
    expect(value).toBe(false);
    expect(source).toBe("factory");
  });

  it("owner override wins over the factory default", async () => {
    await setOwnerValue(db, "core.client_self_registration", true);
    const { value, source } = await resolveSetting(stores, "core.client_self_registration");
    expect(value).toBe(true);
    expect(source).toBe("owner");
  });

  // comms.reminders_enabled is the only client-scoped setting, and it is a
  // capability key. Flag-aware so the matrix proves BOTH: full three-level
  // client resolution when comms is on, and R2 inertness when it is off.
  if (enabledCapabilities.comms === true) {
    it("client preference wins over owner and factory for a client-scoped setting", async () => {
      await setOwnerValue(db, "comms.reminders_enabled", true);
      await setClientValue(db, "comms.reminders_enabled", "client-1", false);

      const forClient1 = await resolveSetting(stores, "comms.reminders_enabled", {
        clientId: "client-1",
      });
      expect(forClient1.value).toBe(false);
      expect(forClient1.source).toBe("client");

      // A different client with no preference falls through to the owner value.
      const forClient2 = await resolveSetting(stores, "comms.reminders_enabled", {
        clientId: "client-2",
      });
      expect(forClient2.value).toBe(true);
      expect(forClient2.source).toBe("owner");
    });
  } else {
    it("a client-scoped OFF-capability key (comms off) is inert — write and read throw", async () => {
      await expect(
        setOwnerValue(db, "comms.reminders_enabled", true),
      ).rejects.toBeInstanceOf(CapabilityDisabledError);
      await expect(
        resolveSetting(stores, "comms.reminders_enabled", { clientId: "client-1" }),
      ).rejects.toBeInstanceOf(CapabilityDisabledError);
    });
  }

  it("ignores a client preference on a NON-client-scoped setting", async () => {
    // core.client_self_registration is not client-scoped: a stray client row
    // must not win. (It is also the only LIVE per-tenant key in the registry
    // today — see the operator/tenant split note in lib/settings/core.settings.ts.)
    await setClientValue(db, "core.client_self_registration", "client-1", true);
    const { value, source } = await resolveSetting(
      stores,
      "core.client_self_registration",
      { clientId: "client-1" },
    );
    expect(value).toBe(false);
    expect(source).toBe("factory");
  });

  it("getSetting returns the effective value directly", async () => {
    await setOwnerValue(db, "core.client_self_registration", true);
    expect(
      await getSetting<boolean>(stores, "core.client_self_registration"),
    ).toBe(true);
  });

  it("falls through owner → OPERATOR → factory for a per-tenant key", async () => {
    // The level added by the two-plane split. An operator value is the app-wide
    // answer: it beats the factory default, and a tenant's own override still
    // beats it. Nothing is copied between levels.
    expect(
      (await resolveSetting(stores, "core.client_self_registration")).source,
    ).toBe("factory");

    await setOperatorValue(db, "core.client_self_registration", true);
    const operator = await resolveSetting(stores, "core.client_self_registration");
    expect(operator.value).toBe(true);
    expect(operator.source).toBe("operator");

    await setOwnerValue(db, "core.client_self_registration", false);
    const owner = await resolveSetting(stores, "core.client_self_registration");
    expect(owner.value).toBe(false);
    expect(owner.source).toBe("owner");
  });

  it("an OPERATOR key ignores the tenant plane entirely, even when a row is there", async () => {
    // The security property, at the read path. setOwnerValue does not know about
    // operatorOnly (the API validator refuses those writes), so a direct caller
    // CAN put a row in the tenant table. It must not be readable: the resolver
    // never consults the tenant plane for an operator key, so a stale or planted
    // row cannot override an operator decision.
    await setOwnerValue(db, "billing.trial_period_days", 3650);
    const factory = await resolveSetting(stores, "billing.trial_period_days");
    expect(factory.value).toBe(14);
    expect(factory.source).toBe("factory");

    await setOperatorValue(db, "billing.trial_period_days", 30);
    const operator = await resolveSetting(stores, "billing.trial_period_days");
    expect(operator.value).toBe(30);
    expect(operator.source).toBe("operator");
  });

  it("resolves an operator key with NO tenant database at all (the anonymous read)", async () => {
    // lib/branding.ts resolves core.app_name in the root layout's
    // generateMetadata, on requests that have no session and therefore no
    // tenant. It must not throw, and must not need a tenant handle.
    const { value, source } = await resolveSetting(
      { catalog: db },
      "core.app_name",
    );
    expect(value).toBe("");
    expect(source).toBe("factory");

    await setOperatorValue(db, "core.app_name", "K9Coach");
    expect(await getSetting<string>({ catalog: db }, "core.app_name")).toBe(
      "K9Coach",
    );
  });
});

describe("unknown-key rejection", () => {
  it("resolveSetting throws UnknownSettingError", async () => {
    await expect(resolveSetting(stores, "core.does_not_exist")).rejects.toBeInstanceOf(
      UnknownSettingError,
    );
  });

  it("validateOwnerWrite rejects an unknown key", () => {
    const r = validateOwnerWrite("nope.not_real", 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_key");
  });
});

describe("bounds rejection", () => {
  it("rejects a value below the minimum", () => {
    // booking.hold_minutes bounds 30–1440.
    const r = validateOwnerWrite("booking.hold_minutes", 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("out_of_bounds");
  });

  it("rejects a value above the maximum", () => {
    const r = validateOwnerWrite("booking.hold_minutes", 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("out_of_bounds");
  });

  it("accepts a value inside the bounds", () => {
    expect(validateOwnerWrite("booking.hold_minutes", 90).ok).toBe(true);
  });

  it("rejects a non-integer for an integer setting", () => {
    const r = validateOwnerWrite("booking.hold_minutes", 90.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("wrong_type");
  });
});

describe("operator keys are refused at every app write path", () => {
  // The core of finding 1's fix, at the validator. These four assertions are
  // what stops a hand-rolled PUT — one that never went near the settings page —
  // from reaching a control the app must not own.
  const OPERATOR_KEYS = [
    "billing.trial_period_days",
    "billing.subscription_grace_days",
    "core.app_name",
    "core.email_reply_to",
  ];

  for (const key of OPERATOR_KEYS) {
    it(`refuses an OWNER write to ${key}`, () => {
      const r = validateOwnerWrite(key, key.startsWith("billing.") ? 3650 : "x");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("operator_only");
    });

    it(`refuses a CLIENT write to ${key}`, () => {
      const r = validateClientWrite(key, key.startsWith("billing.") ? 3650 : "x");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("operator_only");
    });
  }

  it("is absent from BOTH generated views — not rendered read-only", () => {
    const shown = new Set(
      [...visibleDefinitions(false), ...visibleDefinitions(true)].map((d) => d.key),
    );
    for (const key of OPERATOR_KEYS) expect(shown.has(key)).toBe(false);
  });

  it("every operatorOnly definition in the registry is unreachable from the app", () => {
    // Written over the REGISTRY rather than the list above, so a key marked
    // operatorOnly in a future capability is covered the day it is added.
    const operatorKeys = ALL_DEFINITIONS.filter((d) => d.operatorOnly === true);
    expect(operatorKeys.length).toBeGreaterThan(0);
    const shown = new Set(
      [...visibleDefinitions(false), ...visibleDefinitions(true)].map((d) => d.key),
    );
    for (const def of operatorKeys) {
      expect(shown.has(def.key), `${def.key} is rendered on a settings screen`).toBe(false);
      const write = validateOwnerWrite(def.key, def.factoryDefault);
      expect(write.ok, `${def.key} accepted an owner write`).toBe(false);
      if (!write.ok) expect(write.code).toBe("operator_only");
    }
  });
});

describe("owner_editable = false rejection", () => {
  it("rejects an owner write to a factory-locked setting", () => {
    // booking.class_cancel_bulk_refund is ownerEditable:false (policy 7).
    const r = validateOwnerWrite("booking.class_cancel_bulk_refund", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_owner_editable");
  });
});

describe("enum validation", () => {
  it("accepts an allowed option", () => {
    expect(validateOwnerWrite("billing.currency", "GBP").ok).toBe(true);
  });
  it("rejects a value outside the enum", () => {
    const r = validateOwnerWrite("billing.currency", "JPY");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_an_allowed_option");
  });
});

describe("boolean type validation", () => {
  it("rejects a non-boolean for a boolean setting", () => {
    const r = validateOwnerWrite("core.client_self_registration", "yes");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("wrong_type");
  });
});

describe("client-write validation", () => {
  it("rejects a client write to a non-client-scoped setting", () => {
    const r = validateClientWrite("core.client_self_registration", true);
    expect(r.ok).toBe(false);
  });
  it("accepts a client write to a client-scoped setting", () => {
    expect(validateClientWrite("comms.reminders_enabled", true).ok).toBe(true);
  });
});

describe("delete reverts to fall-through (never a copied value)", () => {
  it("removes the owner override and falls back to the factory default", async () => {
    await setOwnerValue(db, "core.client_self_registration", true);
    expect((await resolveSetting(stores, "core.client_self_registration")).source).toBe("owner");

    const removed = await deleteValue(db, "core.client_self_registration", "owner");
    expect(removed).toBe(true);

    const after = await resolveSetting(stores, "core.client_self_registration");
    expect(after.value).toBe(false);
    expect(after.source).toBe("factory");
  });

  it("returns false when there is nothing to delete", async () => {
    expect(await deleteValue(db, "core.client_self_registration", "owner")).toBe(
      false,
    );
  });
});

describe("flag-hidden definitions absent from the generated UI", () => {
  // Flag-aware so the CI both-states matrix (which flips each capability flag
  // ON and OFF) passes the full suite in every leg. At the default posture
  // (payments/booking/comms all OFF) these assert the hidden state; when the
  // matrix flips a flag ON, the same assertions require the visible state.
  it("owner view always includes core", async () => {
    const view = await buildOwnerSettingsView(stores);
    expect(view.map((c) => c.capability)).toContain("core");
  });

  it("the billing capability appears iff it has a CUSTOMER-facing setting to show", async () => {
    // Both kernel subscription-billing keys (grace window, trial length) are
    // OPERATOR keys now, so with payments off the billing capability has nothing
    // a customer may set and correctly renders no section at all. It reappears
    // the moment payments is on. Before the two-plane split this section was
    // always present — and what it showed was the trial length, which is exactly
    // the control that must not be on a customer's screen.
    const view = await buildOwnerSettingsView(stores);
    expect(view.map((c) => c.capability).includes("billing")).toBe(
      enabledCapabilities.payments === true,
    );
  });

  it("a capability's settings surface in the owner view iff its flag is on", async () => {
    const view = await buildOwnerSettingsView(stores);
    const keys = view.flatMap((c) => c.groups.flatMap((g) => g.settings.map((s) => s.key)));
    expect(keys).toContain("core.client_self_registration");
    // Client-payments settings (requiresFlag: "payments") track the flag.
    expect(keys.includes("billing.currency")).toBe(enabledCapabilities.payments === true);
    expect(keys.includes("billing.payment_methods")).toBe(enabledCapabilities.payments === true);
    // booking is owner-scoped; it surfaces here iff booking is on.
    expect(keys.some((k) => k.startsWith("booking."))).toBe(enabledCapabilities.booking === true);
  });

  it("client-scoped view is non-empty iff comms (the only client-scoped capability) is on", () => {
    const clientDefs = visibleDefinitions(true);
    if (enabledCapabilities.comms === true) {
      expect(clientDefs.length).toBeGreaterThan(0);
    } else {
      expect(clientDefs).toHaveLength(0);
    }
  });

  it("groups by capability then functional group with effective values", async () => {
    const view = await buildOwnerSettingsView(stores);
    const core = view.find((c) => c.capability === "core");
    expect(core?.groups.map((g) => g.functionalGroup)).toContain("Identity & access");
    const locked = view
      .flatMap((c) => c.groups.flatMap((g) => g.settings))
      .every((s) => "effectiveValue" in s && "source" in s);
    expect(locked).toBe(true);
  });
});

describe("seed (settings-registry-spec §4 — merges declarations into the seed)", () => {
  it("seeds exactly the ENABLED definitions, idempotently (R2: off-capability keys not seeded)", async () => {
    await runMigrations(client); // second run — must not duplicate
    const res = await client.execute("SELECT COUNT(*) AS n FROM setting_definitions;");
    const n = Number((res.rows[0] as Record<string, unknown>).n);
    const enabled = ALL_DEFINITIONS.filter((d) => isCapabilityEnabled(d.requiresFlag)).length;
    expect(n).toBe(enabled);
  });

  it("an OFF-capability key is absent from the catalogue; core/kernel keys are present", async () => {
    const count = async (key: string): Promise<number> => {
      const r = await client.execute(
        `SELECT COUNT(*) AS n FROM setting_definitions WHERE key = '${key}';`,
      );
      return Number((r.rows[0] as Record<string, unknown>).n);
    };
    // core (no flag) and kernel (subscription_billing) are always seeded.
    expect(await count("core.app_name")).toBe(1);
    expect(await count("billing.subscription_grace_days")).toBe(1);
    // A client-payments key is seeded iff payments is on.
    expect(await count("billing.currency")).toBe(enabledCapabilities.payments === true ? 1 : 0);
  });

  it("re-seeding updates an existing row rather than inserting a duplicate", async () => {
    const q = "SELECT COUNT(*) AS n FROM setting_definitions WHERE key = 'core.app_name';";
    const before = await client.execute(q);
    expect(Number((before.rows[0] as Record<string, unknown>).n)).toBe(1);
    await runMigrations(client);
    const after = await client.execute(q);
    expect(Number((after.rows[0] as Record<string, unknown>).n)).toBe(1);
  });
});
