// Per-request tenant context tests — ADR-023.
//
// The property under test is negative and load-bearing: there is no anonymous
// tenant and no default tenant. A request with no session gets an error, not a
// database — because the alternative, quietly picking one, is how a per-tenant
// app serves one customer another customer's records.
//
// `auth()` is mocked here because the unit under test is the DECISION (which
// tenant, or none), not NextAuth's cookie handling — that is exercised for real
// over HTTP by tests/isolation/per-tenant.spec.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));

import { migrateCatalog } from "@/lib/migrate";
import { __resetCatalogCacheForTests } from "@/lib/catalog";
import { __resetDbCacheForTests } from "@/lib/db";
import {
  SHARED_TENANT_ID,
  currentTenantId,
  getTenantDb,
  requireTenantId,
} from "@/lib/tenant-context";

const CLEARED_KEYS = ["TENANCY_MODE", "DATABASE_URL", "CATALOG_DATABASE_URL"];

let workDir: string;
let catalogUrl: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "house-starter-tenant-ctx-test-"));
  catalogUrl = `file:${join(workDir, "catalog.db")}`;
  await migrateCatalog(catalogUrl);
  const client = createClient({ url: catalogUrl });
  try {
    await client.execute({
      sql: "INSERT INTO tenants (id, db_url, provisioner) VALUES (?, ?, 'file')",
      args: ["TENANT_CTX", `file:${join(workDir, "tenant_ctx.db")}`],
    });
  } finally {
    client.close();
  }
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function clearEnv() {
  for (const key of CLEARED_KEYS) delete process.env[key];
  __resetCatalogCacheForTests();
  __resetDbCacheForTests();
  authMock.mockReset();
}

beforeEach(() => {
  clearEnv();
  process.env.CATALOG_DATABASE_URL = catalogUrl;
});
afterEach(clearEnv);

describe("currentTenantId", () => {
  it("returns the tenant claim carried on the session", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", tenantId: "TENANT_CTX" } });
    expect(await currentTenantId()).toBe("TENANT_CTX");
  });

  it("returns null for an anonymous request", async () => {
    authMock.mockResolvedValue(null);
    expect(await currentTenantId()).toBeNull();
  });

  it("returns null for a session minted before the tenant claim existed", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    expect(await currentTenantId()).toBeNull();
  });

  it("short-circuits to the shared tenant in shared mode, without a session", async () => {
    process.env.TENANCY_MODE = "shared";
    expect(await currentTenantId()).toBe(SHARED_TENANT_ID);
    expect(authMock).not.toHaveBeenCalled();
  });
});

describe("requireTenantId", () => {
  it("throws for an anonymous request rather than choosing a database", async () => {
    authMock.mockResolvedValue(null);
    await expect(requireTenantId()).rejects.toThrowError(/no tenant on this request/);
  });

  it("throws for a session with no tenant claim", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } });
    await expect(requireTenantId()).rejects.toThrowError(/no anonymous or default tenant/);
  });

  it("returns the tenant when the session carries one", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", tenantId: "TENANT_CTX" } });
    expect(await requireTenantId()).toBe("TENANT_CTX");
  });
});

describe("getTenantDb", () => {
  it("hands back the caller's own database", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", tenantId: "TENANT_CTX" } });
    expect(await getTenantDb()).toBeTruthy();
  });

  it("refuses an anonymous caller", async () => {
    authMock.mockResolvedValue(null);
    await expect(getTenantDb()).rejects.toThrowError(/no tenant on this request/);
  });

  it("returns the single shared database in shared mode", async () => {
    process.env.TENANCY_MODE = "shared";
    process.env.DATABASE_URL = ":memory:";
    expect(await getTenantDb()).toBeTruthy();
  });
});
