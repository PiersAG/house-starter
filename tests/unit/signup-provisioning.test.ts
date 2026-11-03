// @vitest-environment node
// A new account's own database, all or nothing (app-business-core issue 358):
// "create that customer's own isolated DB, migrate it, register ... and connect
// per_tenant WITH graceful retry and error handling - NEVER a half-created
// account, never a crash."
//
// The file adapter runs for real (temporary directory, real migrations, real
// catalog rows); failures are injected at each step after the account exists.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateCatalog } from "@/lib/migrate";
import { __resetCatalogCacheForTests, getCatalogDb } from "@/lib/catalog";
import { __resetDbCacheForTests } from "@/lib/db";
import { provisionTenant, tenantFileDir } from "@/lib/tenant/provisioner";
import { pendingTenantOrphans } from "@/lib/tenant/orphans";
import { createUser } from "@/lib/users";
import {
  provisionNewAccount,
  SIGNUP_FAILED_RETRY_SECONDS,
  SIGNUP_PROVISION_FAILED_MESSAGE,
  verifyTenantRoute,
} from "@/lib/tenant/signup-provisioning";

const KEYS = ["TENANCY_MODE", "CATALOG_DATABASE_URL", "TENANT_PROVISIONER", "TENANT_DB_DIR", "VERCEL_ENV"];
let workDir: string;
let catalogUrl: string;
let n = 0;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "house-starter-signup-provisioning-"));
  catalogUrl = `file:${join(workDir, "catalog.db")}`;
  await migrateCatalog(catalogUrl);
});
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function reset() {
  vi.restoreAllMocks();
  for (const k of KEYS) delete process.env[k];
  __resetCatalogCacheForTests();
  __resetDbCacheForTests();
}
beforeEach(() => {
  reset();
  process.env.CATALOG_DATABASE_URL = catalogUrl;
  process.env.TENANT_DB_DIR = join(workDir, "tenants");
  process.env.TENANT_PROVISIONER = "file";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(reset);

async function query(sql: string, args: (string | null)[] = []) {
  const client = createClient({ url: catalogUrl });
  try {
    return (await client.execute({ sql, args })).rows;
  } finally {
    client.close();
  }
}

/** An account as registerUser leaves it: switched off, being set up, no tenant yet. */
async function newAccount(email = `signup-${++n}@example.com`): Promise<{ id: string; email: string }> {
  const user = await createUser(getCatalogDb(), { email, passwordHash: "!", pendingSignup: true });
  return { id: user.id, email };
}

const removed = (database: string) => ({
  ok: false,
  account: "removed",
  database,
  message: SIGNUP_PROVISION_FAILED_MESSAGE,
  retryAfterSeconds: SIGNUP_FAILED_RETRY_SECONDS,
});

const tenantFile = (tenantId: string) => join(tenantFileDir(), `${tenantId}.db`);

describe("provisionNewAccount — success", () => {
  it("creates, migrates and registers the database, and opens it by the catalog's route", async () => {
    const { id, email } = await newAccount();
    const result = await provisionNewAccount(id, email);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(tenantFile(result.tenantId))).toBe(true);
    const [user] = await query("SELECT tenant_id, deactivated_at, signup_pending_since FROM users WHERE id = ?", [id]);
    expect(user.tenant_id).toBe(result.tenantId);
    expect(user.deactivated_at).toBeNull(); // switched on
    expect(user.signup_pending_since).toBeNull();
    // The sign-up's record went in the same write that switched the account on.
    expect(await query("SELECT tenant_id FROM tenant_orphans WHERE tenant_id = ?", [result.tenantId])).toHaveLength(0);
    const [row] = await query("SELECT id, provisioner FROM tenants WHERE id = ?", [result.tenantId]);
    expect(row.provisioner).toBe("file");
    // The connect step: the route leads to a migrated database holding its own row.
    await expect(verifyTenantRoute(result.tenantId)).resolves.toBeUndefined();
  });
});

describe("provisionNewAccount — never a half-created account", () => {
  it("rolls everything back when the database is made but a later step fails", async () => {
    const { id, email } = await newAccount();
    let madeTenant = "";
    const result = await provisionNewAccount(id, email, {
      provision: async (tenantId, opts) => {
        madeTenant = tenantId;
        await provisionTenant(tenantId, opts); // fully made...
        throw new Error("planted failure after the database exists"); // ...then fails
      },
    });
    expect(result).toEqual(removed("removed"));
    expect(await query("SELECT id FROM users WHERE id = ?", [id])).toHaveLength(0);
    expect(await query("SELECT id FROM tenants WHERE id = ?", [madeTenant])).toHaveLength(0);
    expect(existsSync(tenantFile(madeTenant))).toBe(false);
  });

  it("rolls back when the new database does not open by the catalog's route", async () => {
    process.env.TENANCY_MODE = "per_tenant";
    const { id, email } = await newAccount();
    const result = await provisionNewAccount(id, email, {
      verifyRoute: async () => {
        throw new Error("planted: the route leads nowhere");
      },
    });
    expect(result.ok).toBe(false);
    expect(await query("SELECT id FROM users WHERE id = ?", [id])).toHaveLength(0);
  });

  it("knows which database to delete even when the failure comes before registration: the id was recorded first", async () => {
    const { id, email } = await newAccount();
    let seen: string | null = null;
    const destroy = vi.fn(async (tenantId: string) => {
      seen = tenantId;
      return true;
    });
    const result = await provisionNewAccount(id, email, {
      provision: async (tenantId) => {
        // The record exists before Turso is asked for anything.
        const [rec] = await query("SELECT reason FROM tenant_orphans WHERE tenant_id = ?", [tenantId]);
        expect(rec.reason).toBe("signup");
        throw new Error("planted: Turso made the database, then migration failed");
      },
      destroy,
    });
    expect(result).toEqual(removed("removed"));
    expect(seen).toMatch(/^t[0-9a-f]{32}$/);
  });

  it("lists the database for the factory's sweep when the delete is refused", async () => {
    const { id, email } = await newAccount();
    let madeTenant = "";
    const result = await provisionNewAccount(id, email, {
      provision: async (tenantId, opts) => {
        madeTenant = tenantId;
        await provisionTenant(tenantId, opts);
        throw new Error("planted");
      },
      destroy: async () => false, // the app's own key holds no delete right (#439)
    });
    expect(result).toEqual(removed("listed-for-sweep"));
    expect(await pendingTenantOrphans(getCatalogDb())).toContain(madeTenant);
    const [row] = await query("SELECT reason FROM tenant_orphans WHERE tenant_id = ?", [madeTenant]);
    expect(row.reason).toBe("signup");
  });

  it("frees the address: the same email signs up again and succeeds", async () => {
    const { id, email } = await newAccount();
    await provisionNewAccount(id, email, {
      provision: async () => {
        throw new Error("planted");
      },
    });
    const second = await newAccount(email);
    const again = await provisionNewAccount(second.id, email);
    expect(again.ok).toBe(true);
  });

  it("never throws at its caller, whatever fails", async () => {
    const { id, email } = await newAccount();
    await expect(
      provisionNewAccount(id, email, {
        provision: async () => {
          throw new Error("planted");
        },
        destroy: async () => {
          throw new Error("planted: the delete itself throws");
        },
      }),
    ).resolves.toEqual(removed("listed-for-sweep"));
  });
});
