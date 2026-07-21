// Settings registry tests (settings-registry-spec §8 acceptance 1).
//
// Runs the resolver, value store and validation against a REAL in-memory libSQL
// database brought up by the one true migration path (lib/migrate.ts) — which
// also seeds the definitions catalogue — so what is asserted is what production
// executes (same pattern as tests/unit/billing.test.ts). Covers: three-level
// resolution fall-through, unknown-key rejection, bounds rejection,
// owner_editable=false rejection, enum validation, delete-reverts-to-fallthrough,
// flag-hidden definitions absent from the UI, and seed idempotency.

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
import {
  validateOwnerWrite,
  validateClientWrite,
} from "@/lib/settings/validation";
import {
  buildOwnerSettingsView,
  visibleDefinitions,
} from "@/lib/settings/service";
import { ALL_DEFINITIONS } from "@/lib/settings/registry";
import { enabledCapabilities } from "@/config/capabilities";

let client: Client;
let db: AppDatabase;

async function freshDb(): Promise<{ client: Client; db: AppDatabase }> {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  return { client: c, db: drizzle(c) as AppDatabase };
}

beforeEach(async () => {
  ({ client, db } = await freshDb());
});

afterEach(() => {
  client.close();
});

describe("resolution fall-through (all three levels)", () => {
  it("returns the factory default when nothing is set", async () => {
    // core.client_self_registration ships false.
    const { value, source } = await resolveSetting(db, "core.client_self_registration");
    expect(value).toBe(false);
    expect(source).toBe("factory");
  });

  it("owner override wins over the factory default", async () => {
    await setOwnerValue(db, "core.client_self_registration", true);
    const { value, source } = await resolveSetting(db, "core.client_self_registration");
    expect(value).toBe(true);
    expect(source).toBe("owner");
  });

  it("client preference wins over owner and factory for a client-scoped setting", async () => {
    // comms.reminders_enabled is client-scoped; resolution ignores feature flags.
    await setOwnerValue(db, "comms.reminders_enabled", true);
    await setClientValue(db, "comms.reminders_enabled", "client-1", false);

    const forClient1 = await resolveSetting(db, "comms.reminders_enabled", {
      clientId: "client-1",
    });
    expect(forClient1.value).toBe(false);
    expect(forClient1.source).toBe("client");

    // A different client with no preference falls through to the owner value.
    const forClient2 = await resolveSetting(db, "comms.reminders_enabled", {
      clientId: "client-2",
    });
    expect(forClient2.value).toBe(true);
    expect(forClient2.source).toBe("owner");
  });

  it("ignores a client preference on a NON-client-scoped setting", async () => {
    // core.app_name is not client-scoped: a stray client row must not win.
    await setClientValue(db, "core.app_name", "client-1", "Hijacked");
    const { value, source } = await resolveSetting(db, "core.app_name", {
      clientId: "client-1",
    });
    expect(value).toBe("");
    expect(source).toBe("factory");
  });

  it("getSetting returns the effective value directly", async () => {
    await setOwnerValue(db, "billing.overdue_display_days", 14);
    expect(await getSetting<number>(db, "billing.overdue_display_days")).toBe(14);
  });
});

describe("unknown-key rejection", () => {
  it("resolveSetting throws UnknownSettingError", async () => {
    await expect(resolveSetting(db, "core.does_not_exist")).rejects.toBeInstanceOf(
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
    const r = validateClientWrite("core.app_name", "x");
    expect(r.ok).toBe(false);
  });
  it("accepts a client write to a client-scoped setting", () => {
    expect(validateClientWrite("comms.reminders_enabled", true).ok).toBe(true);
  });
});

describe("delete reverts to fall-through (never a copied value)", () => {
  it("removes the owner override and falls back to the factory default", async () => {
    await setOwnerValue(db, "core.client_self_registration", true);
    expect((await resolveSetting(db, "core.client_self_registration")).source).toBe("owner");

    const removed = await deleteValue(db, "core.client_self_registration", "owner");
    expect(removed).toBe(true);

    const after = await resolveSetting(db, "core.client_self_registration");
    expect(after.value).toBe(false);
    expect(after.source).toBe("factory");
  });

  it("returns false when there is nothing to delete", async () => {
    expect(await deleteValue(db, "core.app_name", "owner")).toBe(false);
  });
});

describe("flag-hidden definitions absent from the generated UI", () => {
  // Flag-aware so the CI both-states matrix (which flips each capability flag
  // ON and OFF) passes the full suite in every leg. At the default posture
  // (payments/booking/comms all OFF) these assert the hidden state; when the
  // matrix flips a flag ON, the same assertions require the visible state.
  it("owner view always includes core and the kernel billing setting", async () => {
    const view = await buildOwnerSettingsView(db);
    const capabilities = view.map((c) => c.capability);
    expect(capabilities).toContain("core");
    // subscription_billing is KERNEL (always on) and labelled under "billing".
    expect(capabilities).toContain("billing");
  });

  it("a capability's settings surface in the owner view iff its flag is on", async () => {
    const view = await buildOwnerSettingsView(db);
    const keys = view.flatMap((c) => c.groups.flatMap((g) => g.settings.map((s) => s.key)));
    expect(keys).toContain("core.app_name");
    // Kernel subscription-billing setting: always resolvable, always shown.
    expect(keys).toContain("billing.subscription_grace_days");
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
    const view = await buildOwnerSettingsView(db);
    const core = view.find((c) => c.capability === "core");
    expect(core?.groups.map((g) => g.functionalGroup)).toContain("Identity & access");
    const locked = view
      .flatMap((c) => c.groups.flatMap((g) => g.settings))
      .every((s) => "effectiveValue" in s && "source" in s);
    expect(locked).toBe(true);
  });
});

describe("seed (settings-registry-spec §4 — merges declarations into the seed)", () => {
  it("seeds every registered definition, idempotently", async () => {
    await runMigrations(client); // second run — must not duplicate
    const res = await client.execute("SELECT COUNT(*) AS n FROM setting_definitions;");
    const n = Number((res.rows[0] as Record<string, unknown>).n);
    expect(n).toBe(ALL_DEFINITIONS.length);
  });

  it("re-seeding updates an existing row rather than inserting a duplicate", async () => {
    const before = await client.execute(
      "SELECT COUNT(*) AS n FROM setting_definitions WHERE key = 'billing.currency';",
    );
    expect(Number((before.rows[0] as Record<string, unknown>).n)).toBe(1);
    await runMigrations(client);
    const after = await client.execute(
      "SELECT COUNT(*) AS n FROM setting_definitions WHERE key = 'billing.currency';",
    );
    expect(Number((after.rows[0] as Record<string, unknown>).n)).toBe(1);
  });
});
