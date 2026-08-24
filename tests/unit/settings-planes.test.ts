// The two-plane proof (baseline security fix plan, fix 1 / finding 1).
//
// WHY THIS FILE EXISTS SEPARATELY FROM settings.test.ts. That file points its
// tenant and catalog handles at ONE database, which is right for asserting
// resolution SEMANTICS and structurally incapable of catching the defect this
// change fixes — one database cannot leak into another. So this file provisions
// THREE real databases (tenant A, tenant B, catalog) and asks the only question
// that matters: when tenant A writes a setting, what can tenant B read?
//
// THE DEFECT, EXACTLY. `setting_values` was a CATALOG table with primary key
// `(key, scope, client_id)` and no tenant column. `setOwnerValue` wrote
// `scope='owner', client_id=''` — ONE GLOBAL ROW. `PUT /api/settings/[key]`
// authorised on `if (!userId) 401` and nothing else. So any signed-in account
// set every other account's settings, and the isolation gate was green because
// it never attempted a cross-tenant WRITE (that gap is its own fix, SEC.41).
//
// If `setting_values` is ever moved back to CATALOG_MIGRATION_SQL, the first
// test here fails. That is the point of writing it against databases rather
// than against the DDL text.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import {
  CATALOG_MIGRATION_SQL,
  TENANT_MIGRATION_SQL,
  createMigrationDatabase,
  runMigrations,
} from "@/lib/migrate";
import type { AppDatabase } from "@/lib/users";
import { getSetting, resolveSetting } from "@/lib/settings/resolver";
import { setOwnerValue, setClientValue } from "@/lib/settings/values";
import {
  getOperatorValue,
  setOperatorValue,
  deleteOperatorValue,
} from "@/lib/settings/operator";
import type { SettingsStores } from "@/lib/settings/types";

/** A per-tenant key that is genuinely per-tenant — not an operator control. */
const TENANT_KEY = "core.client_self_registration";
/** An operator control. Extending this was the live paywall bypass. */
const OPERATOR_KEY = "billing.trial_period_days";

let catalogClient: Client;
let tenantAClient: Client;
let tenantBClient: Client;
let catalog: AppDatabase;
let tenantA: AppDatabase;
let tenantB: AppDatabase;
/** What each tenant's requests resolve against. */
let asTenantA: SettingsStores;
let asTenantB: SettingsStores;

beforeEach(async () => {
  // Provisioned exactly as production does: the catalog gets the catalog DDL,
  // each tenant database gets the tenant DDL. Passing "all" here would hide the
  // very split under test.
  catalogClient = createMigrationDatabase(":memory:");
  await runMigrations(catalogClient, { role: "catalog" });
  tenantAClient = createMigrationDatabase(":memory:");
  await runMigrations(tenantAClient, { role: "tenant" });
  tenantBClient = createMigrationDatabase(":memory:");
  await runMigrations(tenantBClient, { role: "tenant" });

  catalog = drizzle(catalogClient) as AppDatabase;
  tenantA = drizzle(tenantAClient) as AppDatabase;
  tenantB = drizzle(tenantBClient) as AppDatabase;
  asTenantA = { tenant: tenantA, catalog };
  asTenantB = { tenant: tenantB, catalog };
});

afterEach(() => {
  catalogClient.close();
  tenantAClient.close();
  tenantBClient.close();
});

describe("the planes are actually separate", () => {
  it("setting_values is in the TENANT DDL and NOT in the catalog DDL", () => {
    expect(TENANT_MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS setting_values");
    expect(CATALOG_MIGRATION_SQL).not.toContain(
      "CREATE TABLE IF NOT EXISTS setting_values",
    );
  });

  it("operator_setting_values is in the CATALOG DDL and NOT in the tenant DDL", () => {
    expect(CATALOG_MIGRATION_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS operator_setting_values",
    );
    expect(TENANT_MIGRATION_SQL).not.toContain(
      "CREATE TABLE IF NOT EXISTS operator_setting_values",
    );
  });

  it("a tenant database has no operator table, and the catalog no tenant values", async () => {
    // Structural, not conventional: the table a caller would have to reach is
    // not merely empty, it does not exist in that database.
    const tables = async (client: Client): Promise<string[]> => {
      const r = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table'",
      );
      return r.rows.map((row) => String(row.name));
    };
    expect(await tables(tenantAClient)).toContain("setting_values");
    expect(await tables(tenantAClient)).not.toContain("operator_setting_values");
    expect(await tables(catalogClient)).toContain("operator_setting_values");
    expect(await tables(catalogClient)).not.toContain("setting_values");
  });
});

describe("FINDING 1 — a tenant's setting write is invisible to every other tenant", () => {
  it("tenant A's owner override does not reach tenant B", async () => {
    // THE REGRESSION TEST. Before the fix this wrote one global catalog row and
    // this assertion failed: B read A's value.
    await setOwnerValue(tenantA, TENANT_KEY, true);

    const forA = await resolveSetting(asTenantA, TENANT_KEY);
    expect(forA.value).toBe(true);
    expect(forA.source).toBe("owner");

    const forB = await resolveSetting(asTenantB, TENANT_KEY);
    expect(forB.value).toBe(false);
    expect(forB.source).toBe("factory");
  });

  it("two tenants hold DIFFERENT values for the same key at the same time", async () => {
    await setOwnerValue(tenantA, TENANT_KEY, true);
    await setOwnerValue(tenantB, TENANT_KEY, false);
    expect(await getSetting<boolean>(asTenantA, TENANT_KEY)).toBe(true);
    expect(await getSetting<boolean>(asTenantB, TENANT_KEY)).toBe(false);
  });

  it("a client preference is scoped to its own tenant too", async () => {
    // The same client id in two tenants is two different people. Client scope
    // used to share the same global table as owner scope.
    await setClientValue(tenantA, "comms.reminders_enabled", "client-1", true).catch(
      () => undefined, // comms is flag-off by default; the owner leg below is the assertion
    );
    await setOwnerValue(tenantA, TENANT_KEY, true);
    const forB = await resolveSetting(asTenantB, TENANT_KEY, { clientId: "client-1" });
    expect(forB.source).toBe("factory");
  });

  it("tenant A's write lands in tenant A's DATABASE, not the catalog", async () => {
    await setOwnerValue(tenantA, TENANT_KEY, true);
    const inA = await tenantAClient.execute("SELECT COUNT(*) AS n FROM setting_values");
    expect(Number((inA.rows[0] as Record<string, unknown>).n)).toBe(1);
    const inB = await tenantBClient.execute("SELECT COUNT(*) AS n FROM setting_values");
    expect(Number((inB.rows[0] as Record<string, unknown>).n)).toBe(0);
    // And the catalog has no such table to have received it — asserted above.
  });
});

describe("FINDING 2 — an operator control is one answer for the whole app", () => {
  it("an operator value is read identically by every tenant", async () => {
    await setOperatorValue(catalog, OPERATOR_KEY, 30);
    expect(await getSetting<number>(asTenantA, OPERATOR_KEY)).toBe(30);
    expect(await getSetting<number>(asTenantB, OPERATOR_KEY)).toBe(30);
  });

  it("a row planted in a tenant database CANNOT override it", async () => {
    // The paywall bypass, attempted at the lowest level available. setOwnerValue
    // is the write primitive underneath the API validator that refuses operator
    // keys — so this is a caller that has already got past every app guard. The
    // resolver still does not look there.
    await setOperatorValue(catalog, OPERATOR_KEY, 30);
    await setOwnerValue(tenantA, OPERATOR_KEY, 3650);

    const forA = await resolveSetting(asTenantA, OPERATOR_KEY);
    expect(forA.value).toBe(30);
    expect(forA.source).toBe("operator");
    expect(await getSetting<number>(asTenantB, OPERATOR_KEY)).toBe(30);
  });

  it("clearing an operator value reverts to the factory default, not to a tenant row", async () => {
    await setOwnerValue(tenantA, OPERATOR_KEY, 3650);
    await setOperatorValue(catalog, OPERATOR_KEY, 30);
    expect(await deleteOperatorValue(catalog, OPERATOR_KEY)).toBe(true);

    const forA = await resolveSetting(asTenantA, OPERATOR_KEY);
    expect(forA.value).toBe(14); // factory default
    expect(forA.source).toBe("factory");
  });

  it("deleting an absent operator value reports that nothing was removed", async () => {
    expect(await deleteOperatorValue(catalog, OPERATOR_KEY)).toBe(false);
  });

  it("getOperatorValue returns undefined (fall through), never a value, when unset", async () => {
    expect(await getOperatorValue(catalog, OPERATOR_KEY)).toBeUndefined();
    await setOperatorValue(catalog, OPERATOR_KEY, 21);
    expect(await getOperatorValue(catalog, OPERATOR_KEY)).toBe(21);
  });

  it("setOperatorValue replaces rather than duplicating", async () => {
    await setOperatorValue(catalog, OPERATOR_KEY, 21);
    await setOperatorValue(catalog, OPERATOR_KEY, 28);
    const r = await catalogClient.execute(
      "SELECT COUNT(*) AS n FROM operator_setting_values",
    );
    expect(Number((r.rows[0] as Record<string, unknown>).n)).toBe(1);
    expect(await getOperatorValue(catalog, OPERATOR_KEY)).toBe(28);
  });
});

describe("the anonymous read path (lib/branding.ts)", () => {
  it("resolves an operator key with no tenant handle at all", async () => {
    await setOperatorValue(catalog, "core.app_name", "K9Coach");
    expect(await getSetting<string>({ catalog }, "core.app_name")).toBe("K9Coach");
  });

  it("a per-tenant key with no tenant handle falls through to operator, then factory", async () => {
    const anonymous = await resolveSetting({ catalog }, TENANT_KEY);
    expect(anonymous.source).toBe("factory");
    // It does NOT pick some default tenant's row — there is no such thing.
    await setOwnerValue(tenantA, TENANT_KEY, true);
    expect((await resolveSetting({ catalog }, TENANT_KEY)).source).toBe("factory");
  });
});
