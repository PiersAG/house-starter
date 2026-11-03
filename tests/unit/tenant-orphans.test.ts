// @vitest-environment node
// A database no account points to is always listed for the factory's sweep,
// never forgotten (app-business-core issues 358 and 857). The sign-up rollback
// is covered in signup-provisioning.test.ts; this covers account erasure, whose
// database delete Turso refuses once the app's key holds no delete right (#439).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const destroyAnswer = vi.hoisted(() => ({ value: true as boolean | Error }));
vi.mock("@/lib/tenant/provisioner", async (orig) => {
  const real = await orig<typeof import("@/lib/tenant/provisioner")>();
  return {
    ...real,
    getProvisioner: () => ({
      name: "file",
      create: async () => ({ url: "file:unused" }),
      destroy: async () => {
        if (destroyAnswer.value instanceof Error) throw destroyAnswer.value;
        return destroyAnswer.value;
      },
    }),
  };
});

import { migrateCatalog } from "@/lib/migrate";
import { __resetCatalogCacheForTests, getCatalogDb } from "@/lib/catalog";
import { liveTenantPlane } from "@/lib/privacy/runtime";
import { clearTenantOrphan, pendingTenantOrphans, recordTenantOrphan } from "@/lib/tenant/orphans";

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hs-ag-orphans-"));
  process.env.CATALOG_DATABASE_URL = `file:${join(dir, "catalog.db")}`;
  __resetCatalogCacheForTests();
  await migrateCatalog(process.env.CATALOG_DATABASE_URL);
});
afterAll(() => {
  delete process.env.CATALOG_DATABASE_URL;
  __resetCatalogCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const T = (n: number) => `t${String(n).padStart(32, "0")}`;

describe("erasure's database delete", () => {
  it("lists nothing when the delete succeeds", async () => {
    destroyAnswer.value = true;
    expect(await liveTenantPlane.destroy!(T(1))).toBe(true);
    expect(await pendingTenantOrphans(getCatalogDb())).not.toContain(T(1));
  });
  it("lists the database when Turso refuses the delete", async () => {
    destroyAnswer.value = false;
    expect(await liveTenantPlane.destroy!(T(2))).toBe(false);
    expect(await pendingTenantOrphans(getCatalogDb())).toContain(T(2));
  });
  it("lists the database when the delete throws", async () => {
    destroyAnswer.value = new Error("planted network failure");
    expect(await liveTenantPlane.destroy!(T(3))).toBe(false);
    expect(await pendingTenantOrphans(getCatalogDb())).toContain(T(3));
  });
});

describe("the orphan list", () => {
  it("keeps the first entry when listed twice, and drops one once the sweep clears it", async () => {
    const db = getCatalogDb();
    await recordTenantOrphan(T(4), "signup", db);
    await recordTenantOrphan(T(4), "erasure", db);
    expect((await pendingTenantOrphans(db)).filter((t) => t === T(4))).toHaveLength(1);
    await clearTenantOrphan(T(4), db);
    expect(await pendingTenantOrphans(db)).not.toContain(T(4));
  });
});
