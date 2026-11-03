// @vitest-environment node
// The sign-up rollback touches only what THIS sign-up made, and never crashes
// (app-business-core issue 358; Dispatch AG's independent review, findings 1
// and 2).
//
//   1 an account that already holds a tenant — an invited member linked to the
//     inviter's workspace, or one re-linked part-way — is never rolled back into
//     that tenant: the inviter's registration and database stay;
//   2 every rollback step may throw; sign-up still answers { ok: false }, names
//     the failed step in the log, and never loses track of the database or
//     leaves a usable account linked to a tenant with no database.
//
// The file adapter and the catalog run for real; a failing step is a catalog
// wrapper that throws on that one operation.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateCatalog } from "@/lib/migrate";
import { __resetCatalogCacheForTests, getCatalogDb } from "@/lib/catalog";
import { __resetDbCacheForTests } from "@/lib/db";
import { tenantOrphans, tenants, users } from "@/lib/schema";
import { ensureTenantForUser, tenantFileDir } from "@/lib/tenant/provisioner";
import { pendingTenantOrphans } from "@/lib/tenant/orphans";
import { provisionNewAccount } from "@/lib/tenant/signup-provisioning";
import type { AppDatabase } from "@/lib/users";

const KEYS = ["TENANCY_MODE", "CATALOG_DATABASE_URL", "TENANT_PROVISIONER", "TENANT_DB_DIR", "VERCEL_ENV"];
let workDir: string;
let catalogUrl: string;
let n = 0;
let errors: string[];

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "house-starter-signup-rollback-"));
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
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
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

async function newAccount(): Promise<{ id: string; email: string }> {
  n += 1;
  const id = `u-rollback-${n}`;
  const email = `rollback-${n}@example.com`;
  await query("INSERT INTO users (id, email, password_hash) VALUES (?, ?, '!')", [id, email]);
  return { id, email };
}

/** An inviter with a finished workspace: account, registration, database. */
async function inviter(): Promise<{ id: string; tenantId: string }> {
  const { id } = await newAccount();
  const tenantId = await ensureTenantForUser(id);
  return { id, tenantId };
}

const tenantFile = (tenantId: string) => join(tenantFileDir(), `${tenantId}.db`);
const registered = async (tenantId: string) => (await query("SELECT id FROM tenants WHERE id = ?", [tenantId])).length === 1;

type Op = "select:users" | "delete:users" | "update:users" | "delete:tenants" | "insert:tenantOrphans" | "update:tenantOrphans";
const TABLES = new Map<unknown, string>([[users, "users"], [tenants, "tenants"], [tenantOrphans, "tenantOrphans"]]);

/**
 * The real catalog, except that each listed operation throws — once armed, so
 * the sign-up's own link and provisioning run normally first.
 */
function failing(ops: Op[], armed: { on: boolean }): AppDatabase {
  const real = getCatalogDb();
  return new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "select") {
        return (...args: unknown[]) => {
          const builder = (value as (...a: unknown[]) => { from: (t: unknown) => unknown }).apply(target, args);
          return new Proxy(builder, {
            get(b, p, r) {
              const v = Reflect.get(b, p, r);
              if (p !== "from") return typeof v === "function" ? v.bind(b) : v;
              return (t: unknown) => {
                if (armed.on && ops.includes(`select:${TABLES.get(t)}` as Op)) throw new Error("planted: select fails");
                return (v as (t: unknown) => unknown).call(b, t);
              };
            },
          });
        };
      }
      if (prop === "delete" || prop === "update" || prop === "insert") {
        return (t: unknown) => {
          if (armed.on && ops.includes(`${String(prop)}:${TABLES.get(t)}` as Op)) {
            throw new Error(`planted: ${String(prop)} ${TABLES.get(t)} fails`);
          }
          return (value as (t: unknown) => unknown).call(target, t);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AppDatabase;
}

/** Provision for real, then fail; `armed` turns the catalog failures on at the failure. */
function failAfterProvisioning(armed: { on: boolean }, made: { id: string }) {
  return async (userId: string, opts: Parameters<typeof ensureTenantForUser>[1]) => {
    made.id = await ensureTenantForUser(userId, opts);
    armed.on = true;
    throw new Error("planted failure after the database exists");
  };
}

describe("finding 1 — the rollback never reaches another account's tenant", () => {
  it("an invited member whose sign-up fails leaves the inviter's tenant row and database untouched", async () => {
    const owner = await inviter();
    const member = await newAccount();
    // The member is already linked to the inviter's workspace.
    await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, member.id]);
    const destroy = vi.fn(async () => true);
    const ensureTenant = vi.fn(ensureTenantForUser);

    const result = await provisionNewAccount(member.id, member.email, { ensureTenant, destroy });

    expect(result).toEqual({ ok: false, database: "none" });
    expect(ensureTenant).not.toHaveBeenCalled(); // stopped before any database was made
    expect(destroy).not.toHaveBeenCalled();
    expect(await registered(owner.tenantId)).toBe(true);
    expect(existsSync(tenantFile(owner.tenantId))).toBe(true);
    expect(await pendingTenantOrphans(getCatalogDb())).not.toContain(owner.tenantId);
    // Nothing rolled back at all: the member's link is as it was.
    const [row] = await query("SELECT tenant_id FROM users WHERE id = ?", [member.id]);
    expect(row.tenant_id).toBe(owner.tenantId);
    expect(errors.join("\n")).toContain("account-missing-or-already-linked");
  });

  it("an account re-linked to another tenant part-way leaves that tenant untouched when the sign-up fails", async () => {
    const owner = await inviter();
    const member = await newAccount();
    const destroy = vi.fn(async () => true);

    const result = await provisionNewAccount(member.id, member.email, {
      ensureTenant: async () => {
        await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, member.id]);
        throw new Error("planted: re-linked, then failed");
      },
      destroy,
    });

    expect(result.ok).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(await registered(owner.tenantId)).toBe(true);
    expect(existsSync(tenantFile(owner.tenantId))).toBe(true);
    expect(await pendingTenantOrphans(getCatalogDb())).not.toContain(owner.tenantId);
  });

  it("refuses a tenant id other than the one it linked, and rolls back only its own", async () => {
    const owner = await inviter();
    const { id, email } = await newAccount();
    const destroyed: string[] = [];
    const result = await provisionNewAccount(id, email, {
      ensureTenant: async () => owner.tenantId, // answers someone else's tenant
      destroy: async (t) => {
        destroyed.push(t);
        return true;
      },
    });
    expect(result.ok).toBe(false);
    expect(destroyed).not.toContain(owner.tenantId);
    expect(await registered(owner.tenantId)).toBe(true);
    expect(existsSync(tenantFile(owner.tenantId))).toBe(true);
  });
});

describe("finding 2 — a rollback step that throws never crashes sign-up", () => {
  it("the account delete fails: the account is deactivated for erasure and keeps its database", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["delete:users"], armed),
      ensureTenant: failAfterProvisioning(armed, made),
    });
    expect(result.ok).toBe(false);
    const [row] = await query("SELECT tenant_id, deactivated_at, deletion_due_at FROM users WHERE id = ?", [id]);
    expect(row.deactivated_at).not.toBeNull(); // sign-in refused
    expect(row.deletion_due_at).not.toBeNull(); // the erasure job takes it, with its database
    // Never "an account with a linked tenant and no database".
    expect(row.tenant_id).toBe(made.id);
    expect(await registered(made.id)).toBe(true);
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(errors.join("\n")).toContain("rollback step delete-account failed");
  });

  it("the account delete and its deactivation both fail: still { ok: false }, database kept and listed", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["delete:users", "update:users"], armed),
      ensureTenant: failAfterProvisioning(armed, made),
    });
    expect(result).toEqual({ ok: false, database: "listed-for-sweep" });
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(await pendingTenantOrphans(getCatalogDb())).toContain(made.id);
    expect(errors.join("\n")).toContain("rollback step deactivate-account failed");
  });

  it("the registration delete fails: the database is still removed", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["delete:tenants"], armed),
      ensureTenant: failAfterProvisioning(armed, made),
    });
    expect(result).toEqual({ ok: false, database: "removed" });
    expect(existsSync(tenantFile(made.id))).toBe(false);
    expect(await query("SELECT id FROM users WHERE id = ?", [id])).toHaveLength(0);
    expect(errors.join("\n")).toContain("rollback step delete-registration failed");
  });

  it("listing the orphan fails and the delete is refused: the registration is kept as its record", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["insert:tenantOrphans"], armed),
      ensureTenant: failAfterProvisioning(armed, made),
      destroy: async () => false,
    });
    expect(result).toEqual({ ok: false, database: "none" });
    // The database was not lost track of: its registration still says where it is.
    expect(await registered(made.id)).toBe(true);
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(errors.join("\n")).toContain("rollback step record-orphan failed");
  });

  it("the orphan is listed BEFORE anything that would lose track of the database", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const seenListed: boolean[] = [];
    const result = await provisionNewAccount(id, email, {
      ensureTenant: failAfterProvisioning(armed, made),
      destroy: async (t) => {
        seenListed.push((await pendingTenantOrphans(getCatalogDb())).includes(t));
        // At the delete the account is already gone; the list is the record.
        seenListed.push((await query("SELECT id FROM users WHERE id = ?", [id])).length === 0);
        return true;
      },
    });
    expect(result).toEqual({ ok: false, database: "removed" });
    expect(seenListed).toEqual([true, true]);
    expect(await pendingTenantOrphans(getCatalogDb())).not.toContain(made.id); // cleared once gone
  });

  it("reading the link back fails: the database is listed, not deleted", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const destroy = vi.fn(async () => true);
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["select:users"], armed),
      ensureTenant: failAfterProvisioning(armed, made),
      destroy,
    });
    expect(result).toEqual({ ok: false, database: "listed-for-sweep" });
    expect(destroy).not.toHaveBeenCalled();
    expect(await pendingTenantOrphans(getCatalogDb())).toContain(made.id);
    expect(errors.join("\n")).toContain("rollback step read-link failed");
  });

  it("clearing the orphan after the delete fails: still { ok: false }", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["update:tenantOrphans"], armed),
      ensureTenant: failAfterProvisioning(armed, made),
    });
    expect(result).toEqual({ ok: false, database: "removed" });
    expect(errors.join("\n")).toContain("rollback step clear-orphan failed");
  });

  it("every catalog step fails at once: still { ok: false }, nothing thrown", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    await expect(
      provisionNewAccount(id, email, {
        catalog: failing(
          ["select:users", "delete:users", "update:users", "delete:tenants", "insert:tenantOrphans", "update:tenantOrphans"],
          armed,
        ),
        ensureTenant: failAfterProvisioning(armed, made),
        destroy: async () => {
          throw new Error("planted: the delete throws too");
        },
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("the log write throwing does not crash sign-up", async () => {
    const log = await import("@/lib/observability/log");
    vi.spyOn(log, "logEvent").mockImplementation(() => {
      throw new Error("planted: logging fails");
    });
    const { id, email } = await newAccount();
    await expect(
      provisionNewAccount(id, email, {
        ensureTenant: async () => {
          throw new Error("planted");
        },
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});
