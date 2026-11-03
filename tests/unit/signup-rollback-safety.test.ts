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
import { __resetDbCacheForTests, getDb } from "@/lib/db";
import { tenantOrphans, tenants, users } from "@/lib/schema";
import { ensureTenantForUser, getProvisioner, tenantFileDir } from "@/lib/tenant/provisioner";
import { pendingTenantOrphans } from "@/lib/tenant/orphans";
import { provisionNewAccount, verifyTenantRoute } from "@/lib/tenant/signup-provisioning";
import { isDeactivated } from "@/lib/privacy/deactivation";
import { runRetentionJob } from "@/lib/privacy/retention-job";
import { createUser, getUserById, PENDING_SIGNUP_EXPIRY_MS, registerUser, type AppDatabase } from "@/lib/users";

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

/** A new sign-up exactly as registerUser makes it: switched off, being set up. */
async function newAccount(): Promise<{ id: string; email: string }> {
  n += 1;
  const email = `rollback-${n}@example.com`;
  const user = await createUser(getCatalogDb(), { email, passwordHash: "!", pendingSignup: true });
  return { id: user.id, email };
}

/** An account that is switched on (the seeded owner, or a finished sign-up). */
async function activeAccount(): Promise<{ id: string; email: string }> {
  n += 1;
  const email = `rollback-${n}@example.com`;
  const user = await createUser(getCatalogDb(), { email, passwordHash: "!" });
  return { id: user.id, email };
}

/** An inviter with a finished workspace: account, registration, database. */
async function inviter(): Promise<{ id: string; tenantId: string }> {
  const { id } = await activeAccount();
  const tenantId = await ensureTenantForUser(id);
  return { id, tenantId };
}

/** The account's switch and link, as sign-in and the retention job read them. */
async function account(id: string) {
  const rows = await query(
    "SELECT tenant_id, deactivated_at, deletion_due_at, signup_pending_since FROM users WHERE id = ?",
    [id],
  );
  return rows[0];
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
  it("an invited member still being set up is refused and leaves the inviter's tenant row and database untouched", async () => {
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
    // Still switched off: refusing it never switches it on.
    expect((await account(member.id)).deactivated_at).not.toBeNull();
  });

  // The review's "to confirm" item: such an account used to be told "nothing
  // was saved" although it exists and works, and a retry then got "email taken".
  it("an account already set up (switched on, workspace registered and opening) is told so: signed in, nothing made or undone", async () => {
    const owner = await inviter();
    const member = await activeAccount();
    await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, member.id]);
    const ensureTenant = vi.fn(ensureTenantForUser);
    const destroy = vi.fn(async () => true);
    const verifyRoute = vi.fn(async () => undefined);

    const result = await provisionNewAccount(member.id, member.email, { ensureTenant, destroy, verifyRoute });

    expect(result).toEqual({ ok: true, tenantId: owner.tenantId, alreadySetUp: true });
    expect(verifyRoute).toHaveBeenCalledWith(owner.tenantId); // its workspace opens
    expect(ensureTenant).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(await registered(owner.tenantId)).toBe(true);
    const row = await account(member.id);
    expect(row.tenant_id).toBe(owner.tenantId);
    expect(row.deactivated_at).toBeNull();
    // A retry answers the same, so it is handled correctly too.
    expect(await provisionNewAccount(member.id, member.email, { ensureTenant, destroy, verifyRoute })).toEqual(result);
  });

  it("an account whose existing workspace does not open is not told it is set up", async () => {
    const owner = await inviter();
    const member = await activeAccount();
    await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, member.id]);
    const result = await provisionNewAccount(member.id, member.email, {
      verifyRoute: async () => {
        throw new Error("planted: the workspace does not open");
      },
    });
    expect(result).toEqual({ ok: false, database: "none" });
  });

  it("an account its owner closed is never given a workspace or switched back on", async () => {
    const closed = await activeAccount();
    await query("UPDATE users SET deactivated_at = unixepoch(), deletion_due_at = unixepoch() + 86400 WHERE id = ?", [closed.id]);
    const ensureTenant = vi.fn(ensureTenantForUser);
    const result = await provisionNewAccount(closed.id, closed.email, { ensureTenant });
    expect(result).toEqual({ ok: false, database: "none" });
    expect(ensureTenant).not.toHaveBeenCalled();
    const row = await account(closed.id);
    expect(row.tenant_id).toBeNull();
    expect(row.deactivated_at).not.toBeNull();
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

  it("listing the orphan fails: the account is kept, switched off, as the record of its database", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const destroy = vi.fn(async () => false);
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["insert:tenantOrphans"], armed),
      ensureTenant: failAfterProvisioning(armed, made),
      destroy,
    });
    expect(result).toEqual({ ok: false, database: "kept-with-account" });
    // The database was not lost track of: the account's link and its registration say where it is.
    const row = await account(id);
    expect(row.tenant_id).toBe(made.id);
    expect(row.deactivated_at).not.toBeNull();
    expect(row.deletion_due_at).not.toBeNull();
    expect(await registered(made.id)).toBe(true);
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
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

// Dispatch AG's second independent review (review/report.md, point 2).
describe("second review, defect A — a database that was made is never lost track of", () => {
  /** Turso makes the database, then its migration fails: no `tenants` row is ever written. */
  function madeThenMigrationFails(armed: { on: boolean }, made: { id: string }) {
    return async (userId: string) => {
      const [row] = await query("SELECT tenant_id FROM users WHERE id = ?", [userId]);
      made.id = String(row.tenant_id);
      await getProvisioner(process.env).create(made.id); // the database exists at the platform
      armed.on = true;
      throw new Error("planted: the migration failed after the database was made");
    };
  }

  it("record-orphan throws and the delete is refused: the account is kept, its link naming the database", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const destroy = vi.fn(async () => false); // the app's key has lost the delete right (#439)
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["insert:tenantOrphans"], armed),
      ensureTenant: madeThenMigrationFails(armed, made),
      destroy,
    });

    expect(result).toEqual({ ok: false, database: "kept-with-account" });
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(await registered(made.id)).toBe(false); // no registration was ever written
    expect(await pendingTenantOrphans(getCatalogDb())).not.toContain(made.id); // and no list entry
    // The database's name is still findable in the catalog: the account links it.
    const holders = await query("SELECT id FROM users WHERE tenant_id = ?", [made.id]);
    expect(holders.map((r) => r.id)).toEqual([id]);
    // Switched off, its erasure due now: the retention job erases it with the database.
    const row = await account(id);
    expect(row.deactivated_at).not.toBeNull();
    expect(Number(row.deletion_due_at)).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
    expect(errors.join("\n")).toContain("rollback step record-orphan failed");
    expect(errors.join("\n")).not.toContain("rollback step delete-account");
  });

  it("the unsure path: read-link fails, then record-orphan fails — the account is still kept as the record", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const destroy = vi.fn(async () => false);
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["select:users", "insert:tenantOrphans"], armed),
      ensureTenant: madeThenMigrationFails(armed, made),
      destroy,
    });

    expect(result).toEqual({ ok: false, database: "kept-with-account" });
    expect(destroy).not.toHaveBeenCalled();
    const holders = await query("SELECT id FROM users WHERE tenant_id = ?", [made.id]);
    expect(holders.map((r) => r.id)).toEqual([id]);
    expect((await account(id)).deactivated_at).not.toBeNull();
    expect(errors.join("\n")).toContain("rollback step read-link failed");
    expect(errors.join("\n")).toContain("rollback step record-orphan failed");
  });

  it("keeping the account fails too: it still exists, switched off, linked to the database", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["insert:tenantOrphans", "update:users"], armed),
      ensureTenant: madeThenMigrationFails(armed, made),
      destroy: async () => false,
    });
    expect(result).toEqual({ ok: false, database: "kept-with-account" });
    const row = await account(id);
    expect(row.tenant_id).toBe(made.id);
    expect(row.deactivated_at).not.toBeNull(); // off since it was created
    expect(row.deletion_due_at).not.toBeNull(); // the creation's own expiry: still erased
    expect(errors.join("\n")).toContain("rollback step keep-account failed");
  });
});

describe("second review, defect B — an account is switched on only once its database is ready", () => {
  it("registerUser creates every sign-up switched off, so sign-in refuses it", async () => {
    const user = await registerUser(getCatalogDb(), { email: `fresh-${++n}@example.com`, password: "a-long-enough-passphrase-1" });
    expect(user.signupPendingSince).not.toBeNull();
    expect(isDeactivated(user)).toBe(true); // lib/auth.ts authorize returns null for it
    expect(user.deletionDueAt).not.toBeNull(); // an abandoned sign-up is erased
  });

  it("success: provisioned, then switched on — the account signs in", async () => {
    const { id, email } = await newAccount();
    const result = await provisionNewAccount(id, email);
    expect(result.ok).toBe(true);
    const row = await account(id);
    expect(row.deactivated_at).toBeNull();
    expect(row.signup_pending_since).toBeNull();
    expect(row.deletion_due_at).toBeNull();
    expect(isDeactivated(await getUserById(getCatalogDb(), id))).toBe(false);
  });

  it("the account is still switched off while its database is being made and checked", async () => {
    const { id, email } = await newAccount();
    const seen: unknown[] = [];
    const result = await provisionNewAccount(id, email, {
      verifyRoute: async (t) => {
        seen.push((await account(id)).deactivated_at);
        await verifyTenantRoute(t);
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
  });

  it("switching it on fails: the sign-up is rolled back, never left on", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const destroy = vi.fn(async () => true);
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["update:users"], armed),
      verifyRoute: async () => {
        armed.on = true; // the switch-on is the next users update
      },
      destroy,
    });
    expect(result).toEqual({ ok: false, database: "removed" });
    expect(await query("SELECT id FROM users WHERE id = ?", [id])).toHaveLength(0);
  });

  it("provisioning fails and every rollback step fails too: the account is left switched off", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(
        ["select:users", "delete:users", "update:users", "delete:tenants", "insert:tenantOrphans", "update:tenantOrphans"],
        armed,
      ),
      ensureTenant: failAfterProvisioning(armed, made),
      destroy: async () => {
        throw new Error("planted: the delete throws too");
      },
    });
    expect(result.ok).toBe(false);
    const row = await account(id);
    expect(row.deactivated_at).not.toBeNull();
    expect(row.signup_pending_since).not.toBeNull();
    expect(isDeactivated(await getUserById(getCatalogDb(), id))).toBe(true);
  });

  it("the address of a sign-up still being set up gets a plain answer, not 'sign in'", async () => {
    const email = `pending-${++n}@example.com`;
    await createUser(getCatalogDb(), { email, passwordHash: "!", pendingSignup: true });
    await expect(registerUser(getCatalogDb(), { email, password: "a-long-enough-passphrase-1" })).rejects.toThrow(
      "still being set up",
    );
  });

  it("the retention job erases an account kept as a database's only record, though the database was never registered", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    let minted = "";
    await provisionNewAccount(id, email, {
      catalog: failing(["insert:tenantOrphans"], armed),
      ensureTenant: async (userId) => {
        const [row] = await query("SELECT tenant_id FROM users WHERE id = ?", [userId]);
        minted = String(row.tenant_id);
        await getProvisioner(process.env).create(minted);
        armed.on = true;
        throw new Error("planted: the migration failed after the database was made");
      },
      destroy: async () => false,
    });
    expect(await registered(minted)).toBe(false);
    const removed: string[] = [];
    const run = await runRetentionJob(getCatalogDb(), {
      now: new Date(Date.now() + 60_000),
      tenantPlane: {
        open: async (t) => getDb(t), // would throw: the database is not registered
        destroy: async (t) => {
          removed.push(t);
          return getProvisioner(process.env).destroy(t);
        },
      },
    });
    expect(run.erased.map((r) => r.userId)).toContain(id);
    expect(removed).toContain(minted);
    expect(existsSync(tenantFile(minted))).toBe(false);
    expect(await query("SELECT id FROM users WHERE tenant_id = ?", [minted])).toHaveLength(0);
  });

  it("the retention job erases an abandoned sign-up and its database, with no erasure email", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    // Every rollback step fails: only the creation's own expiry is left to clean up.
    await provisionNewAccount(id, email, {
      catalog: failing(["select:users", "delete:users", "update:users", "delete:tenants", "insert:tenantOrphans"], armed),
      ensureTenant: failAfterProvisioning(armed, made),
      destroy: async () => false,
    });
    const confirm = vi.fn(async () => undefined);
    const removed: string[] = [];
    const run = await runRetentionJob(getCatalogDb(), {
      now: new Date(Date.now() + PENDING_SIGNUP_EXPIRY_MS + 60_000),
      confirm,
      // The erasure finds the database by the account's link (lib/privacy/deletion.ts eraseAccount).
      tenantPlane: {
        open: async (t) => getDb(t),
        destroy: async (t) => {
          removed.push(t);
          return getProvisioner(process.env).destroy(t);
        },
      },
    });
    expect(run.erased.map((r) => r.userId)).toContain(id);
    expect(removed).toContain(made.id);
    expect(existsSync(tenantFile(made.id))).toBe(false);
    expect(await query("SELECT id FROM users WHERE id = ?", [id])).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
  });
});
