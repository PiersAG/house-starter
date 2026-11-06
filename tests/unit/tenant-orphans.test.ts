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
import { clearTenantOrphan, pendingTenantOrphans, recordTenantOrphan, settleTenantOrphans, SIGNUP_GRACE_MS } from "@/lib/tenant/orphans";
import { runRetentionJob } from "@/lib/privacy/retention-job";
import { tenantOrphans, tenants, users } from "@/lib/schema";
import { eq } from "drizzle-orm";

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

describe("settling the list after the factory's erase job (Dispatch AO)", () => {
  const HOUR = 60 * 60 * 1000;
  async function row(id: string) {
    return (await getCatalogDb().select().from(tenantOrphans).where(eq(tenantOrphans.tenantId, id)).all())[0];
  }
  async function register(id: string) {
    await getCatalogDb().insert(tenants).values({ id, dbUrl: `file:${id}.db`, provisioner: "file" }).run();
  }

  it("clears an erasure row only when the platform says the database is gone", async () => {
    const db = getCatalogDb();
    await recordTenantOrphan(T(10), "erasure", db);
    await recordTenantOrphan(T(11), "erasure", db);
    const later = new Date(Date.now() + 2 * HOUR);
    const r = await settleTenantOrphans(async (id) => id === T(11), db, later);
    expect(r.cleared).toContain(T(10));
    expect(r.waiting).toContain(T(11));
    expect((await row(T(10))).clearedAt).not.toBeNull();
    expect((await row(T(11))).clearedAt).toBeNull();
  });

  it("never clears on an unclear answer", async () => {
    const db = getCatalogDb();
    await recordTenantOrphan(T(12), "erasure", db);
    const r = await settleTenantOrphans(async () => { throw new Error("planted 503"); }, db, new Date(Date.now() + 2 * HOUR));
    expect(r.unknown).toContain(T(12));
    expect((await row(T(12))).clearedAt).toBeNull();
  });

  it("leaves a sign-up row alone for its first hour, then removes its registration with it", async () => {
    const db = getCatalogDb();
    await recordTenantOrphan(T(13), "signup", db);
    await register(T(13));
    const early = await settleTenantOrphans(async () => false, db, new Date(Date.now() + SIGNUP_GRACE_MS / 2));
    expect(early.waiting).toContain(T(13));
    expect((await row(T(13))).clearedAt).toBeNull();
    const r = await settleTenantOrphans(async () => false, db, new Date(Date.now() + 2 * HOUR));
    expect(r.cleared).toContain(T(13));
    expect(await db.select().from(tenants).where(eq(tenants.id, T(13))).all()).toHaveLength(0);
  });

  it("keeps a sign-up's registration while an account links the tenant", async () => {
    const db = getCatalogDb();
    await recordTenantOrphan(T(14), "signup", db);
    await register(T(14));
    await db.insert(users).values({ id: "u-ao-14", email: "ao14@example.test", passwordHash: "not-a-real-hash", tenantId: T(14) }).run();
    await settleTenantOrphans(async () => false, db, new Date(Date.now() + 2 * HOUR));
    expect(await db.select().from(tenants).where(eq(tenants.id, T(14))).all()).toHaveLength(1);
  });

  it("runs as step 4 of the daily retention job, and not at all without an existence check", async () => {
    const db = getCatalogDb();
    await recordTenantOrphan(T(15), "erasure", db);
    const without = await runRetentionJob(db, { tenantPlane: { open: async () => { throw new Error("unused"); } } });
    expect(without.orphans).toBeUndefined();
    expect((await row(T(15))).clearedAt).toBeNull();
    const run = await runRetentionJob(db, {
      now: new Date(Date.now() + 2 * HOUR),
      tenantPlane: { open: async () => { throw new Error("unused"); }, exists: async () => false },
    });
    expect(run.orphans?.cleared).toContain(T(15));
  });
});
