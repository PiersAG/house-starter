// Tenant provisioning tests — ADR-023, the sign-up half of the routing seam.
//
// Two properties matter more than the mechanics:
//
//   1. A tenant that has been provisioned is REACHABLE — its database exists,
//      carries the tenant schema, and the catalog routes to it. Anything less
//      and sign-up "succeeds" into a workspace the customer can never open.
//   2. A deployed environment NEVER silently downgrades to the local file
//      adapter. Writing a customer's database into a serverless container's
//      disk looks like success and loses the account at the next cold start,
//      which is strictly worse than an error page.
//
// The file adapter is exercised for real (temporary directories, real
// migrations, real catalog rows). The Turso adapter is exercised at its
// decision points — selection and fail-closed construction — without calling
// the platform API, which needs a paid account and a network.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateCatalog } from "@/lib/migrate";
import { __resetCatalogCacheForTests } from "@/lib/catalog";
import { __resetDbCacheForTests, getDb } from "@/lib/db";
import {
  FileTenantProvisioner,
  TursoTenantProvisioner,
  ensureTenantForUser,
  getProvisioner,
  newTenantId,
  provisionTenant,
  selectProvisionerName,
  tenantFileDir,
  tursoDatabaseName,
} from "@/lib/tenant/provisioner";

/**
 * A standalone environment for a selection test. NodeJS.ProcessEnv requires
 * NODE_ENV, and building these by hand rather than mutating process.env keeps
 * each case's inputs visible in the case itself.
 */
function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides } as NodeJS.ProcessEnv;
}

const CLEARED_KEYS = [
  "TENANCY_MODE",
  "DATABASE_URL",
  "CATALOG_DATABASE_URL",
  "TENANT_PROVISIONER",
  "TENANT_DB_DIR",
  "VERCEL_ENV",
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "APP_SLUG",
];

let workDir: string;
let catalogUrl: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "house-starter-provisioner-test-"));
  catalogUrl = `file:${join(workDir, "catalog.db")}`;
  await migrateCatalog(catalogUrl);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function clearEnv() {
  for (const key of CLEARED_KEYS) delete process.env[key];
  __resetCatalogCacheForTests();
  __resetDbCacheForTests();
}

beforeEach(() => {
  clearEnv();
  process.env.CATALOG_DATABASE_URL = catalogUrl;
  process.env.TENANT_DB_DIR = join(workDir, "tenants");
  process.env.TENANT_PROVISIONER = "file";
});
afterEach(clearEnv);

/** Insert a catalog account with no tenant, as sign-up does before provisioning. */
async function createAccount(id: string, email: string, tenantId: string | null = null) {
  const client = createClient({ url: catalogUrl });
  try {
    await client.execute({
      sql:
        "INSERT INTO users (id, email, password_hash, tenant_id) VALUES (?, ?, '!', ?) " +
        "ON CONFLICT(email) DO UPDATE SET tenant_id = excluded.tenant_id",
      args: [id, email, tenantId],
    });
  } finally {
    client.close();
  }
}

async function catalogRow(tenantId: string) {
  const client = createClient({ url: catalogUrl });
  try {
    const r = await client.execute({
      sql: "SELECT id, db_url, provisioner, label FROM tenants WHERE id = ?",
      args: [tenantId],
    });
    return r.rows[0] as Record<string, unknown> | undefined;
  } finally {
    client.close();
  }
}

async function userRow(userId: string) {
  const client = createClient({ url: catalogUrl });
  try {
    const r = await client.execute({
      sql: "SELECT id, email, tenant_id FROM users WHERE id = ?",
      args: [userId],
    });
    return r.rows[0] as Record<string, unknown> | undefined;
  } finally {
    client.close();
  }
}

describe("newTenantId", () => {
  it("mints an opaque id that lib/db.ts accepts and Turso can name", () => {
    const id = newTenantId();
    expect(id).toMatch(/^t[0-9a-f]{32}$/);
    // No underscore, so the lowercase/dash mapping below round-trips exactly.
    expect(id).not.toContain("_");
  });

  it("does not repeat", () => {
    expect(newTenantId()).not.toBe(newTenantId());
  });
});

describe("selectProvisionerName", () => {
  it("honours an explicit TENANT_PROVISIONER", () => {
    expect(selectProvisionerName(env({ TENANT_PROVISIONER: "file" }))).toBe("file");
    expect(selectProvisionerName(env({ TENANT_PROVISIONER: "turso" }))).toBe("turso");
  });

  it("rejects an unrecognised TENANT_PROVISIONER rather than guessing", () => {
    expect(() => selectProvisionerName(env({ TENANT_PROVISIONER: "postgres" }))).toThrowError(
      /must be "file" or "turso"/,
    );
  });

  it("selects turso in a deployed environment", () => {
    expect(selectProvisionerName(env({ VERCEL_ENV: "production" }))).toBe("turso");
    expect(selectProvisionerName(env({ VERCEL_ENV: "preview" }))).toBe("turso");
  });

  it("selects file for local dev and CI", () => {
    expect(selectProvisionerName(env({}))).toBe("file");
    // NODE_ENV=production alone is NOT a deployed environment — `next build`
    // sets it in CI, which has no Turso credentials and should not need them.
    expect(selectProvisionerName(env({ NODE_ENV: "production" }))).toBe("file");
  });
});

describe("the production adapter never falls back", () => {
  it("throws, naming the missing secrets, instead of writing a local file", () => {
    // The single most important behaviour in this module. A deployed app with
    // no Turso credentials must FAIL, not quietly provision a file.
    expect(() => getProvisioner(env({ VERCEL_ENV: "production" }))).toThrowError(
      /TURSO_API_TOKEN and TURSO_ORG/,
    );
    expect(() => getProvisioner(env({ VERCEL_ENV: "production" }))).toThrowError(
      /Refusing to provision/,
    );
    expect(() =>
      getProvisioner(env({ VERCEL_ENV: "production", TURSO_API_TOKEN: "x" })),
    ).toThrowError(/TURSO_ORG/);
    expect(() =>
      getProvisioner(env({ VERCEL_ENV: "production", TURSO_ORG: "piersag" })),
    ).toThrowError(/TURSO_API_TOKEN/);
  });

  it("builds the Turso adapter when both are present", () => {
    const p = getProvisioner(
      env({
        VERCEL_ENV: "production",
        TURSO_API_TOKEN: "token-not-real",
        TURSO_ORG: "piersag",
        APP_SLUG: "k9coach",
      }),
    );
    expect(p).toBeInstanceOf(TursoTenantProvisioner);
    expect(p.name).toBe("turso");
  });

  it("builds the file adapter locally", () => {
    expect(getProvisioner(env({}))).toBeInstanceOf(FileTenantProvisioner);
  });
});

describe("tursoDatabaseName", () => {
  it("is <app-slug>-<tenant-id>, lower-cased with underscores mapped to dashes", () => {
    expect(tursoDatabaseName("k9coach", "t0123456789abcdef0123456789abcdef")).toBe(
      "k9coach-t0123456789abcdef0123456789abcdef",
    );
    expect(tursoDatabaseName("k9coach", "TENANT_A")).toBe("k9coach-tenant-a");
  });

  it("rejects a name Turso would not accept rather than mangling it", () => {
    expect(() => tursoDatabaseName("k9coach", "a".repeat(64))).toThrowError(
      /not a valid Turso database name/,
    );
  });
});

describe("FileTenantProvisioner", () => {
  it("defaults to .build/tenants under the working directory", () => {
    expect(tenantFileDir(env({}))).toBe(join(process.cwd(), ".build/tenants"));
  });

  it("resolves a relative TENANT_DB_DIR against the working directory", () => {
    expect(tenantFileDir(env({ TENANT_DB_DIR: "var/tenants" }))).toBe(
      join(process.cwd(), "var/tenants"),
    );
  });

  it("creates one file per tenant and is idempotent", async () => {
    const dir = join(workDir, "explicit");
    const provisioner = new FileTenantProvisioner(env({ TENANT_DB_DIR: dir }));
    const first = await provisioner.create("TENANT_FILE");
    expect(first.url).toBe(`file:${join(dir, "TENANT_FILE.db")}`);
    expect(existsSync(join(dir, "TENANT_FILE.db"))).toBe(true);
    expect(await provisioner.create("TENANT_FILE")).toEqual(first);
  });

  it("rejects a tampered tenant id before touching the filesystem", async () => {
    const provisioner = new FileTenantProvisioner(env({ TENANT_DB_DIR: workDir }));
    await expect(provisioner.create("../escape")).rejects.toThrowError(
      /invalid tenantId/,
    );
  });
});

describe("provisionTenant", () => {
  it("creates, migrates, stamps and registers — and getDb then routes to it", async () => {
    const tenantId = newTenantId();
    const created = await provisionTenant(tenantId, { label: "trainer@example.test" });

    // Registered in the catalog…
    const row = await catalogRow(tenantId);
    expect(row?.db_url).toBe(created.url);
    expect(row?.provisioner).toBe("file");
    expect(row?.label).toBe("trainer@example.test");

    // …migrated, and stamped with its own row…
    const client = createClient({ url: created.url });
    try {
      const meta = await client.execute("SELECT tenant_id, label FROM tenant_meta");
      expect(meta.rows[0]?.tenant_id).toBe(tenantId);
      expect(meta.rows[0]?.label).toBe("trainer@example.test");
      // Identity is NOT in the tenant database — the whole point of the split.
      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table'",
      );
      expect(tables.rows.map((r) => String(r.name))).not.toContain("users");
    } finally {
      client.close();
    }

    // …and reachable through the app's own resolver.
    __resetCatalogCacheForTests();
    __resetDbCacheForTests();
    const { url } = await (async () => ({ url: (await catalogRow(tenantId))!.db_url }))();
    expect(url).toBe(created.url);
    expect(await getDb(tenantId)).toBeTruthy();
  });

  it("is idempotent — re-provisioning the same tenant converges", async () => {
    const tenantId = newTenantId();
    const first = await provisionTenant(tenantId, { label: "a@example.test" });
    const second = await provisionTenant(tenantId, { label: "a@example.test" });
    expect(second).toEqual(first);
    expect((await catalogRow(tenantId))?.db_url).toBe(first.url);
  });
});

describe("ensureTenantForUser", () => {
  it("provisions on first use and records the mapping on the account", async () => {
    await createAccount("user-1", "one@example.test");
    const tenantId = await ensureTenantForUser("user-1");
    expect(tenantId).toMatch(/^t[0-9a-f]{32}$/);
    expect((await userRow("user-1"))?.tenant_id).toBe(tenantId);
    expect(await catalogRow(tenantId)).toBeTruthy();
  });

  it("is a plain lookup once the tenant exists", async () => {
    await createAccount("user-2", "two@example.test");
    const first = await ensureTenantForUser("user-2");
    const second = await ensureTenantForUser("user-2");
    expect(second).toBe(first);
  });

  it("re-provisions under the SAME id when the mapping outlived the registry", async () => {
    // A sign-up that died between writing the user mapping and registering the
    // tenant. Converge rather than minting a second tenant and orphaning the
    // first one's data.
    const orphanId = newTenantId();
    await createAccount("user-3", "three@example.test", orphanId);
    expect(await catalogRow(orphanId)).toBeUndefined();

    const resolved = await ensureTenantForUser("user-3");
    expect(resolved).toBe(orphanId);
    expect(await catalogRow(orphanId)).toBeTruthy();
  });

  it("throws for an account the catalog does not have", async () => {
    await expect(ensureTenantForUser("user-nobody")).rejects.toThrowError(
      /no catalog account/,
    );
  });
});
