// @vitest-environment node
// Record first, then create (app-business-core issue 358; Dispatch AG-fix4).
//
// Four independent reviews each found a narrower order of failures in which a
// database the sign-up made lost its last record, because it was found through
// the account or its link. Now the sign-up's tenant id is written to
// tenant_orphans BEFORE Turso is asked for anything, and that record goes only
// in the write that switches the finished account on. This file holds:
//
//   * every failing combination named in the four review reports, each showing
//     the database is still findable afterwards (its record is still there);
//   * a property test that fails each rollback step in every combination, at
//     every point a sign-up can fail, with and without a re-link part-way;
//   * the answer the person gets for each outcome — one fixed "please try
//     again", never "wait an hour" (CEO ruling 2026-11-03, Dispatch AG-fix5) —
//     and that a retry with the same email then works at once;
//   * account erasure of an unfinished sign-up never touching a tenant.
//
// The file adapter and the catalog run for real; a failing step is a catalog
// wrapper that throws on that one operation once armed.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateCatalog } from "@/lib/migrate";
import { __resetCatalogCacheForTests, getCatalogDb } from "@/lib/catalog";
import { __resetDbCacheForTests, getDb } from "@/lib/db";
import { tenantOrphans, tenants, users } from "@/lib/schema";
import { ensureTenantForUser, getProvisioner, provisionTenant, tenantFileDir } from "@/lib/tenant/provisioner";
import { pendingTenantOrphans } from "@/lib/tenant/orphans";
import {
  provisionNewAccount,
  signupFailure,
  SIGNUP_PROVISION_FAILED_MESSAGE,
  verifyTenantRoute,
  type SignupProvisionDeps,
  type SignupProvisionFailure,
  type SignupProvisionResult,
} from "@/lib/tenant/signup-provisioning";
import { isDeactivated } from "@/lib/privacy/deactivation";
import { runRetentionJob } from "@/lib/privacy/retention-job";
import { eraseAccount } from "@/lib/privacy/deletion";
import {
  ACCOUNT_EXISTS_MESSAGE,
  createUser,
  getUserByEmail,
  getUserById,
  PENDING_SIGNUP_EXPIRY_MS,
  registerUser,
  SignupRetryError,
  type AppDatabase,
} from "@/lib/users";
import { SIGNUP_FAILED_MESSAGE, SIGNUP_FAILED_RETRY_SECONDS } from "@/lib/signup-failure";

const KEYS = ["TENANCY_MODE", "CATALOG_DATABASE_URL", "TENANT_PROVISIONER", "TENANT_DB_DIR", "VERCEL_ENV"];
const PASSWORD = "a-long-enough-passphrase-1";
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

async function query(sql: string, args: (string | number | null)[] = []) {
  const client = createClient({ url: catalogUrl });
  try {
    return (await client.execute({ sql, args })).rows;
  } finally {
    client.close();
  }
}

/** A new sign-up exactly as registerUser makes it: switched off, being set up, linked to nothing. */
async function newAccount(email = `rollback-${++n}@example.com`): Promise<{ id: string; email: string }> {
  const user = await createUser(getCatalogDb(), { email, passwordHash: "!", pendingSignup: true });
  return { id: user.id, email };
}

/** An account that is switched on (the seeded owner, or a finished sign-up). */
async function activeAccount(): Promise<{ id: string; email: string }> {
  const email = `rollback-${++n}@example.com`;
  const user = await createUser(getCatalogDb(), { email, passwordHash: "!" });
  return { id: user.id, email };
}

/** An inviter with a finished workspace: account, registration, database. */
async function inviter(): Promise<{ id: string; tenantId: string }> {
  const { id } = await activeAccount();
  const tenantId = await ensureTenantForUser(id);
  return { id, tenantId };
}

async function account(id: string) {
  const rows = await query(
    "SELECT tenant_id, deactivated_at, deletion_due_at, signup_pending_since FROM users WHERE id = ?",
    [id],
  );
  return rows[0];
}

const tenantFile = (tenantId: string) => join(tenantFileDir(), `${tenantId}.db`);
const registered = async (tenantId: string) => (await query("SELECT id FROM tenants WHERE id = ?", [tenantId])).length === 1;
/** The sign-up's record is still there: the rollback, the erasure jobs and the sweep can find the database. */
const findable = async (tenantId: string) => (await pendingTenantOrphans(getCatalogDb())).includes(tenantId);

/** The invariant every outcome must hold: a database, or a registration, that exists is recorded. */
async function neverLost(tenantId: string) {
  if (existsSync(tenantFile(tenantId)) || (await registered(tenantId))) {
    expect(await findable(tenantId)).toBe(true);
  }
}

/** Someone else's workspace is exactly as it was. */
async function untouched(owner: { id: string; tenantId: string }) {
  expect(await registered(owner.tenantId)).toBe(true);
  expect(existsSync(tenantFile(owner.tenantId))).toBe(true);
  expect(await findable(owner.tenantId)).toBe(false);
  await expect(verifyTenantRoute(owner.tenantId)).resolves.toBeUndefined();
  expect((await account(owner.id)).tenant_id).toBe(owner.tenantId);
}

type Op =
  | "select:users"
  | "delete:users"
  | "update:users"
  | "delete:tenants"
  | "insert:tenantOrphans"
  | "delete:tenantOrphans";
const TABLES = new Map<unknown, string>([[users, "users"], [tenants, "tenants"], [tenantOrphans, "tenantOrphans"]]);

/** The real catalog, except that each listed operation throws once armed. */
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

/** Where a sign-up fails. */
type FailAt = "before-create" | "created-unregistered" | "registered" | "verify" | "switch-on";

/**
 * Deps that fail the sign-up at `at`, arming the catalog failures at that
 * moment. `made.id` is the recorded tenant id.
 */
function failAt(at: FailAt, armed: { on: boolean }, made: { id: string }): Pick<SignupProvisionDeps, "provision" | "verifyRoute"> {
  return {
    provision: async (tenantId, opts) => {
      made.id = tenantId;
      if (at === "before-create") {
        armed.on = true;
        throw new Error("planted: Turso refused the create");
      }
      if (at === "created-unregistered") {
        await getProvisioner(process.env).create(tenantId); // exists at the platform...
        armed.on = true;
        throw new Error("planted: the migration failed after the database was made"); // ...never registered
      }
      await provisionTenant(tenantId, opts);
      if (at === "registered") {
        armed.on = true;
        throw new Error("planted failure after the database is registered");
      }
    },
    verifyRoute: async (tenantId) => {
      await verifyTenantRoute(tenantId);
      if (at === "verify") {
        armed.on = true;
        throw new Error("planted: the route leads nowhere");
      }
      if (at === "switch-on") {
        armed.on = true; // the switch-on write is next
      }
    },
  };
}

/** Re-link exactly this account (the reviews' "re-link part-way"). */
function relinking(userId: string, to: string, at: FailAt, armed: { on: boolean }, made: { id: string }) {
  const deps = failAt(at, armed, made);
  const relink = () => query("UPDATE users SET tenant_id = ? WHERE id = ?", [to, userId]);
  return {
    provision: async (tenantId: string, opts: { label: string | null; env: NodeJS.ProcessEnv }) => {
      if (at === "before-create") await relink();
      if (at === "created-unregistered") {
        made.id = tenantId;
        await getProvisioner(process.env).create(tenantId);
        await relink();
        armed.on = true;
        throw new Error("planted: the migration failed after the database was made");
      }
      if (at === "registered") {
        made.id = tenantId;
        await provisionTenant(tenantId, opts);
        await relink();
        armed.on = true;
        throw new Error("planted failure after the database is registered");
      }
      return deps.provision!(tenantId, opts);
    },
    verifyRoute: async (tenantId: string) => {
      if (at === "verify" || at === "switch-on") await relink();
      return deps.verifyRoute!(tenantId);
    },
  };
}

/** Every failed sign-up's answer: what was left, and the one fixed message. */
const answer = (account: string) => (database: string) => ({
  ok: false,
  account,
  database,
  message: SIGNUP_FAILED_MESSAGE,
  retryAfterSeconds: SIGNUP_FAILED_RETRY_SECONDS,
});
const removedAnswer = answer("removed");
const existsAnswer = answer("exists");
const keptAnswer = answer("kept");

/** A tenant plane over the real file adapter that records every removal. */
function plane(removed: string[]) {
  return {
    open: async (t: string) => getDb(t),
    destroy: async (t: string) => {
      removed.push(t);
      return getProvisioner(process.env).destroy(t);
    },
  };
}
const anHourOn = () => new Date(Date.now() + PENDING_SIGNUP_EXPIRY_MS + 60_000);

describe("record first, then create", () => {
  it("the record exists before Turso is asked for anything, and goes with the switch-on", async () => {
    const { id, email } = await newAccount();
    const seen: boolean[] = [];
    const result = await provisionNewAccount(id, email, {
      provision: async (tenantId, opts) => {
        seen.push(await findable(tenantId));
        await provisionTenant(tenantId, opts);
      },
    });
    expect(seen).toEqual([true]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await findable(result.tenantId)).toBe(false);
    expect(await query("SELECT tenant_id FROM tenant_orphans WHERE tenant_id = ?", [result.tenantId])).toHaveLength(0);
    const row = await account(id);
    expect(row.tenant_id).toBe(result.tenantId);
    expect(row.deactivated_at).toBeNull();
    expect(row.signup_pending_since).toBeNull();
    expect(row.deletion_due_at).toBeNull();
  });

  it("the record cannot be written: no database is asked for, the account is removed", async () => {
    const { id, email } = await newAccount();
    const provision = vi.fn(async () => undefined);
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["insert:tenantOrphans"], { on: true }),
      provision,
    });
    expect(result).toEqual(removedAnswer("none"));
    expect(provision).not.toHaveBeenCalled();
    expect(await query("SELECT id FROM users WHERE id = ?", [id])).toHaveLength(0);
  });

  it("the record cannot be written and the account cannot be deleted: still nothing made, and the person is told to try again", async () => {
    const { id, email } = await newAccount();
    const provision = vi.fn(async () => undefined);
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["insert:tenantOrphans", "delete:users"], { on: true }),
      provision,
    });
    expect(result).toEqual(keptAnswer("none"));
    expect(provision).not.toHaveBeenCalled();
    expect(isDeactivated(await getUserById(getCatalogDb(), id))).toBe(true);
  });

  it("the switch-on and the record's removal are one write: if the record cannot go, the account is not switched on", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      // At the switch-on the record's delete throws; the rollback's own record delete then works.
      catalog: failing(["delete:tenantOrphans"], armed),
      ...failAt("switch-on", armed, made),
      destroy: async () => false,
    });
    expect(result.ok).toBe(false);
    // Never switched on, never linked; the record still names the database.
    expect(await query("SELECT id FROM users WHERE id = ? AND signup_pending_since IS NULL", [id])).toHaveLength(0);
    expect(await query("SELECT id FROM users WHERE tenant_id = ?", [made.id])).toHaveLength(0);
    expect(await findable(made.id)).toBe(true);
    await neverLost(made.id);
  });

  it("the switch-on's answer is lost after it was written: the account is read back, switched on, and the sign-up succeeds", async () => {
    const { id, email } = await newAccount();
    const real = getCatalogDb();
    const catalog = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "batch") {
          return async (...args: unknown[]) => {
            await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            throw new Error("planted: the connection dropped after the write");
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AppDatabase;
    const destroy = vi.fn(async () => true);
    const result = await provisionNewAccount(id, email, { catalog, destroy });
    expect(result.ok).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
    expect(isDeactivated(await getUserById(getCatalogDb(), id))).toBe(false);
  });

  it("a switched-on account is never deleted by a rollback", async () => {
    const { id, email } = await newAccount();
    const real = getCatalogDb();
    let reads = 0;
    // The switch-on is written but its answer lost, and the read-back fails too.
    const catalog = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "batch") {
          return async (...args: unknown[]) => {
            await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            throw new Error("planted: the connection dropped after the write");
          };
        }
        if (prop === "select") {
          return (...args: unknown[]) => {
            reads += 1;
            if (reads === 2) throw new Error("planted: the read-back fails");
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AppDatabase;
    const destroy = vi.fn(async () => true);
    const result = await provisionNewAccount(id, email, { catalog, destroy });
    // The rollback reads the account it could not delete, so the answer is what a retry gets.
    expect(result).toEqual(existsAnswer("listed-for-sweep"));
    // The account is on and linked: the rollback deleted neither it nor its database.
    const row = await account(id);
    expect(row.signup_pending_since).toBeNull();
    expect(destroy).not.toHaveBeenCalled();
    expect(existsSync(tenantFile(String(row.tenant_id)))).toBe(true);
  });
});

describe("the account could not be read after it was not deleted", () => {
  it("answers the same fixed message", async () => {
    const { id, email } = await newAccount();
    const real = getCatalogDb();
    let reads = 0;
    // Switched on behind the sign-up's back, then the read of it fails.
    const catalog = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "select") {
          return (...args: unknown[]) => {
            reads += 1;
            if (reads >= 2) throw new Error("planted: reads fail");
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AppDatabase;
    const result = await provisionNewAccount(id, email, {
      catalog,
      provision: async () => {
        await query("UPDATE users SET signup_pending_since = NULL, deactivated_at = NULL WHERE id = ?", [id]);
        throw new Error("planted");
      },
    });
    expect(result).toEqual(answer("unknown")("listed-for-sweep"));
    expect(errors.join("\n")).toContain("rollback step read-account failed");
  });
});

describe("review 1 — the rollback only ever touches this sign-up's own account and tenant", () => {
  it("an invited member already linked to the inviter's workspace: nothing made or undone, the inviter untouched", async () => {
    const owner = await inviter();
    const member = await newAccount();
    await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, member.id]);
    const provision = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => true);
    const result = await provisionNewAccount(member.id, member.email, { provision, destroy });
    expect(result).toEqual(keptAnswer("none"));
    expect(provision).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect((await account(member.id)).tenant_id).toBe(owner.tenantId);
    expect(isDeactivated(await getUserById(getCatalogDb(), member.id))).toBe(true);
    await untouched(owner);
  });

  it("an account already set up (switched on, workspace registered and opening) is told so: signed in, nothing made or undone", async () => {
    const owner = await inviter();
    const member = await activeAccount();
    await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, member.id]);
    const provision = vi.fn(async () => undefined);
    const verifyRoute = vi.fn(async () => undefined);
    const result = await provisionNewAccount(member.id, member.email, { provision, verifyRoute });
    expect(result).toEqual({ ok: true, tenantId: owner.tenantId, alreadySetUp: true });
    expect(verifyRoute).toHaveBeenCalledWith(owner.tenantId);
    expect(provision).not.toHaveBeenCalled();
    expect(await provisionNewAccount(member.id, member.email, { provision, verifyRoute })).toEqual(result);
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
    expect(result).toEqual(existsAnswer("none"));
    // A retry never takes over a switched-on account: it is told to sign in.
    await expect(registerUser(getCatalogDb(), { email: member.email, password: PASSWORD })).rejects.toThrow(ACCOUNT_EXISTS_MESSAGE);
  });

  it("an account its owner closed is never given a workspace or switched back on", async () => {
    const closed = await activeAccount();
    await query("UPDATE users SET deactivated_at = unixepoch(), deletion_due_at = unixepoch() + 86400 WHERE id = ?", [closed.id]);
    const provision = vi.fn(async () => undefined);
    expect(await provisionNewAccount(closed.id, closed.email, { provision })).toEqual(existsAnswer("none"));
    await expect(registerUser(getCatalogDb(), { email: closed.email, password: PASSWORD })).rejects.toThrow(ACCOUNT_EXISTS_MESSAGE);
    expect(provision).not.toHaveBeenCalled();
    const row = await account(closed.id);
    expect(row.tenant_id).toBeNull();
    expect(row.deactivated_at).not.toBeNull();
  });

  it("no such account: nothing made, and the person is told to try again", async () => {
    const provision = vi.fn(async () => undefined);
    expect(await provisionNewAccount("no-such-account", null, { provision })).toEqual(removedAnswer("none"));
    expect(provision).not.toHaveBeenCalled();
  });

  it("every rollback step throwing still answers { ok: false }, and names each failed step", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["select:users", "delete:users", "delete:tenants", "delete:tenantOrphans"], armed),
      ...failAt("registered", armed, made),
      destroy: async () => {
        throw new Error("planted: the delete throws too");
      },
    });
    expect(result).toEqual(keptAnswer("listed-for-sweep"));
    expect(errors.join("\n")).toContain("rollback step delete-account failed");
    expect(errors.join("\n")).toContain("rollback step read-links failed");
    await neverLost(made.id);
  });

  it("the log write throwing does not crash sign-up", async () => {
    const log = await import("@/lib/observability/log");
    vi.spyOn(log, "logEvent").mockImplementation(() => {
      throw new Error("planted: logging fails");
    });
    const { id, email } = await newAccount();
    await expect(
      provisionNewAccount(id, email, {
        provision: async () => {
          throw new Error("planted");
        },
      }),
    ).resolves.toEqual(removedAnswer("removed"));
  });
});

describe("review 2 — a database that was made is never lost track of", () => {
  it("defect A: made, never registered, the delete refused — the record still names it", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["insert:tenantOrphans"], armed), // the old "record-orphan fails": there is no such step now
      ...failAt("created-unregistered", armed, made),
      destroy: async () => false, // the app's key has lost the delete right (#439)
    });
    expect(result).toEqual(removedAnswer("listed-for-sweep"));
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(await registered(made.id)).toBe(false);
    expect(await findable(made.id)).toBe(true);
    expect(await query("SELECT id FROM users WHERE id = ?", [id])).toHaveLength(0);
  });

  it("defect A, the unsure path: reading the links fails — nothing deleted, the record still names it", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const destroy = vi.fn(async () => true);
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["select:users", "insert:tenantOrphans"], armed),
      ...failAt("created-unregistered", armed, made),
      destroy,
    });
    expect(result).toEqual(removedAnswer("listed-for-sweep"));
    expect(destroy).not.toHaveBeenCalled();
    expect(await findable(made.id)).toBe(true);
    expect(errors.join("\n")).toContain("rollback step read-links failed");
  });

  it("defect B: the account cannot be deleted — it stays switched off and linked to nothing, never a usable account without a database", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["delete:users"], armed),
      ...failAt("registered", armed, made),
    });
    expect(result).toEqual(keptAnswer("removed"));
    const row = await account(id);
    expect(row.tenant_id).toBeNull();
    expect(row.deactivated_at).not.toBeNull();
    expect(isDeactivated(await getUserById(getCatalogDb(), id))).toBe(true);
    expect(existsSync(tenantFile(made.id))).toBe(false); // nothing linked it, so it was removed
    expect(await findable(made.id)).toBe(false);
  });
});

describe("review 3 — erasure and re-links", () => {
  it("finding 1: a refused invited member is erased an hour later; the inviter's workspace is untouched", async () => {
    const owner = await inviter();
    const member = await newAccount();
    await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, member.id]);
    expect(await provisionNewAccount(member.id, member.email)).toEqual(keptAnswer("none"));
    const removed: string[] = [];
    const run = await runRetentionJob(getCatalogDb(), { now: anHourOn(), tenantPlane: plane(removed) });
    const erased = run.erased.find((r) => r.userId === member.id);
    expect(erased?.tenantDatabase).toBe("none");
    expect(erased?.tenantKept).toBe("unfinished-sign-up");
    expect(removed).not.toContain(owner.tenantId);
    await untouched(owner);
  });

  it("finding 1, once the inviter's own account is gone too: a pending account's link never erases that workspace", async () => {
    const owner = await inviter();
    const member = await newAccount();
    await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, member.id]);
    await query("DELETE FROM users WHERE id = ?", [owner.id]);
    const removed: string[] = [];
    await runRetentionJob(getCatalogDb(), { now: anHourOn(), tenantPlane: plane(removed) });
    expect(removed).not.toContain(owner.tenantId);
    expect(await registered(owner.tenantId)).toBe(true);
    expect(existsSync(tenantFile(owner.tenantId))).toBe(true);
  });

  it("finding 2: re-linked part-way after the database was made — the minted database removed, the other workspace untouched", async () => {
    const owner = await inviter();
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const destroyed: string[] = [];
    const result = await provisionNewAccount(id, email, {
      ...relinking(id, owner.tenantId, "registered", armed, made),
      destroy: async (t) => {
        destroyed.push(t);
        return getProvisioner(process.env).destroy(t);
      },
    });
    expect(result).toEqual(removedAnswer("removed"));
    expect(destroyed).toEqual([made.id]);
    expect(await findable(made.id)).toBe(false);
    expect(existsSync(tenantFile(made.id))).toBe(false);
    await untouched(owner);
  });

  it("the rollback never deletes the minted database while another account links it; the record stays", async () => {
    const { id, email } = await newAccount();
    const other = await activeAccount();
    const destroy = vi.fn(async () => true);
    let minted = "";
    const result = await provisionNewAccount(id, email, {
      provision: async (tenantId, opts) => {
        minted = tenantId;
        await provisionTenant(tenantId, opts);
        await query("UPDATE users SET tenant_id = ? WHERE id = ?", [tenantId, other.id]);
        throw new Error("planted: another account linked the tenant, then the sign-up failed");
      },
      destroy,
    });
    expect(result).toEqual(removedAnswer("listed-for-sweep"));
    expect(destroy).not.toHaveBeenCalled();
    expect(existsSync(tenantFile(minted))).toBe(true);
    expect(await findable(minted)).toBe(true);
  });
});

describe("review 4 — the exact sequences", () => {
  it("defect A: re-linked to T2, then the orphan write fails, the account delete succeeds and the database delete is refused — still findable", async () => {
    const owner = await inviter(); // T2
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      // Every write to tenant_orphans after the failure throws: the rollback never needs one.
      catalog: failing(["insert:tenantOrphans"], armed),
      ...relinking(id, owner.tenantId, "registered", armed, made),
      destroy: async () => false,
    });
    expect(result).toEqual(removedAnswer("listed-for-sweep"));
    expect(await query("SELECT id FROM users WHERE id = ?", [id])).toHaveLength(0); // delete-account succeeded
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(await findable(made.id)).toBe(true);
    await untouched(owner);
  });

  it("defect A, milder: the account delete fails too — the account is kept linked to T2, and erasing it later leaves T2 and the minted record alone", async () => {
    const owner = await inviter();
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["insert:tenantOrphans", "delete:users"], armed),
      ...relinking(id, owner.tenantId, "registered", armed, made),
      destroy: async () => false,
    });
    expect(result).toEqual(keptAnswer("listed-for-sweep"));
    expect((await account(id)).tenant_id).toBe(owner.tenantId);
    const removed: string[] = [];
    const run = await runRetentionJob(getCatalogDb(), { now: anHourOn(), tenantPlane: plane(removed) });
    expect(run.erased.find((r) => r.userId === id)?.tenantKept).toBe("unfinished-sign-up");
    expect(removed).toEqual([]);
    expect(await query("SELECT id FROM users WHERE id = ?", [id])).toHaveLength(0);
    // Erasing the account erased no record of the database: it is the record's, not the account's.
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(await findable(made.id)).toBe(true);
    await untouched(owner);
  });

  it("an unfinished sign-up still linked to its own minted tenant is erased as an account only; the record leads the sweep to the database", async () => {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    // The account somehow ended linked to its minted id, and every rollback step failed.
    const result = await provisionNewAccount(id, email, {
      catalog: failing(["select:users", "delete:users", "delete:tenants", "delete:tenantOrphans"], armed),
      provision: async (tenantId, opts) => {
        made.id = tenantId;
        await provisionTenant(tenantId, opts);
        await query("UPDATE users SET tenant_id = ? WHERE id = ?", [tenantId, id]);
        armed.on = true;
        throw new Error("planted");
      },
      destroy: async () => false,
    });
    expect(result.ok).toBe(false);
    const removed: string[] = [];
    const erased = await eraseAccount(getCatalogDb(), id, { tenantPlane: plane(removed) });
    expect(erased?.tenantKept).toBe("unfinished-sign-up");
    expect(removed).toEqual([]);
    expect(await findable(made.id)).toBe(true);
    await neverLost(made.id);
  });
});

describe("property: every combination of failing rollback steps, at every point a sign-up can fail", () => {
  const STEPS: { name: string; op?: Op }[] = [
    { name: "delete-account", op: "delete:users" },
    { name: "read-links", op: "select:users" },
    { name: "delete-database" },
    { name: "delete-registration", op: "delete:tenants" },
    { name: "clear-record", op: "delete:tenantOrphans" },
  ];
  const POINTS: FailAt[] = ["before-create", "created-unregistered", "registered", "verify", "switch-on"];

  for (const at of POINTS) {
    for (const relink of [false, true]) {
      it(`fails at ${at}${relink ? ", re-linked to another tenant part-way" : ""}: the database is never lost, nothing else is touched, the answer is true`, async () => {
        const owner = await inviter();
        for (let mask = 0; mask < 1 << STEPS.length; mask++) {
          const down = STEPS.filter((_, i) => mask & (1 << i));
          const ops = down.flatMap((s) => (s.op ? [s.op] : []));
          // The switch-on's own write must work for the "switch-on" point to reach it,
          // so that point fails it with a planted update instead.
          if (at === "switch-on") ops.push("update:users");
          const { id, email } = await newAccount();
          const armed = { on: false };
          const made = { id: "" };
          const destroyDown = down.some((s) => s.name === "delete-database");
          const deps = relink ? relinking(id, owner.tenantId, at, armed, made) : failAt(at, armed, made);
          let result: SignupProvisionResult | undefined;
          await expect(
            (async () => {
              result = await provisionNewAccount(id, email, {
                catalog: failing(ops, armed),
                ...deps,
                destroy: async (t) => (destroyDown ? false : getProvisioner(process.env).destroy(t)),
              });
            })(),
          ).resolves.toBeUndefined();
          const label = `${at}${relink ? "+relink" : ""} down=[${down.map((s) => s.name).join(",")}]`;
          expect(result?.ok, label).toBe(false);
          if (!result || result.ok) continue;

          // 1 the database this sign-up made (or its registration) is always findable.
          expect(made.id, label).toMatch(/^t[0-9a-f]{32}$/);
          if (existsSync(tenantFile(made.id)) || (await registered(made.id))) {
            expect(await findable(made.id), label).toBe(true);
          }
          // 2 the account: gone, or kept switched off and never linked to the minted id.
          const row = await account(id);
          if (result.account === "removed") {
            expect(row, label).toBeUndefined();
            expect(result.message, label).toBe(SIGNUP_PROVISION_FAILED_MESSAGE);
          } else {
            expect(result.account, label).toBe("kept"); // none of these runs ever switches the account on
            expect(row, label).toBeDefined();
            expect(row.tenant_id, label).not.toBe(made.id);
            expect(isDeactivated(await getUserById(getCatalogDb(), id)), label).toBe(true);
            expect(result.message, label).toBe(SIGNUP_FAILED_MESSAGE);
            // 3 a retry at once: an account linked to nothing is removed and the
            // sign-up goes on afresh; one re-linked to another tenant is never
            // taken over, and the person is told to try again.
            if (row.tenant_id === null) {
              const fresh = await registerUser(getCatalogDb(), { email, password: PASSWORD });
              expect(fresh.id, label).not.toBe(id);
              expect(await account(id), label).toBeUndefined();
            } else {
              await expect(registerUser(getCatalogDb(), { email, password: PASSWORD }), label).rejects.toThrow(
                SIGNUP_FAILED_MESSAGE,
              );
            }
          }
          // 4 the other workspace is exactly as it was.
          expect(await findable(owner.tenantId), label).toBe(false);
          expect(await registered(owner.tenantId), label).toBe(true);
          expect(existsSync(tenantFile(owner.tenantId)), label).toBe(true);
        }
        // 5 the retention job then erases every kept account; still nothing lost, the other workspace untouched.
        const removed: string[] = [];
        await runRetentionJob(getCatalogDb(), { now: anHourOn(), tenantPlane: plane(removed) });
        expect(removed).not.toContain(owner.tenantId);
        for (const row of await query("SELECT tenant_id FROM tenant_orphans WHERE cleared_at IS NULL")) {
          await neverLost(String(row.tenant_id));
        }
        await untouched(owner);
      }, 120_000);
    }
  }
});

describe("a failed sign-up never makes the person wait: a retry with the same email works at once (CEO ruling 2026-11-03)", () => {
  /** A sign-up that failed with its account kept switched off and linked to nothing; `made.id` its recorded tenant. */
  async function keptSignup(at: FailAt = "registered") {
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    const result = await provisionNewAccount(id, email, { catalog: failing(["delete:users"], armed), ...failAt(at, armed, made) });
    expect(result).toMatchObject({ ok: false, account: "kept", message: SIGNUP_FAILED_MESSAGE });
    expect((await account(id)).tenant_id).toBeNull();
    return { id, email, made };
  }

  /** The retry: registered and given its database at once, switched on. */
  async function retryNow(email: string) {
    const fresh = await registerUser(getCatalogDb(), { email, password: PASSWORD });
    const done = await provisionNewAccount(fresh.id, email);
    expect(done.ok).toBe(true);
    const user = await getUserById(getCatalogDb(), fresh.id);
    expect(isDeactivated(user)).toBe(false);
    expect(user?.signupPendingSince).toBeNull();
    return { fresh, tenantId: done.ok ? done.tenantId : "" };
  }

  it("the account was removed: the fixed message, and a retry at once succeeds", async () => {
    const { id, email } = await newAccount();
    const result = await provisionNewAccount(id, email, {
      provision: async () => {
        throw new Error("planted");
      },
    });
    expect(result).toEqual(removedAnswer("removed"));
    await retryNow(email);
  });

  it("the account was kept switched off: the fixed message, and a retry at once removes it and signs up afresh", async () => {
    const { id, email } = await keptSignup();
    const { fresh } = await retryNow(email);
    expect(fresh.id).not.toBe(id);
    expect(await getUserById(getCatalogDb(), id)).toBeUndefined();
    expect((await getUserByEmail(getCatalogDb(), email))?.id).toBe(fresh.id);
  });

  it("the earlier attempt's tenant record is left for the sweep: never deleted, never lost", async () => {
    // The database was made and its delete refused, so only the record leads to it.
    const { id, email } = await newAccount();
    const armed = { on: false };
    const made = { id: "" };
    await provisionNewAccount(id, email, {
      catalog: failing(["delete:users"], armed),
      ...failAt("registered", armed, made),
      destroy: async () => false,
    });
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(await findable(made.id)).toBe(true);
    const { tenantId } = await retryNow(email);
    expect(tenantId).not.toBe(made.id);
    expect(existsSync(tenantFile(made.id))).toBe(true);
    expect(await findable(made.id)).toBe(true);
    const [row] = await query("SELECT reason, cleared_at FROM tenant_orphans WHERE tenant_id = ?", [made.id]);
    expect(row.reason).toBe("signup");
    expect(row.cleared_at).toBeNull();
    // Nothing links it, so the sweep may remove it; the retry's own tenant is not recorded.
    expect(await query("SELECT id FROM users WHERE tenant_id = ?", [made.id])).toHaveLength(0);
    expect(await findable(tenantId)).toBe(false);
  });

  it("the earlier attempt's record is kept whatever point it failed at", async () => {
    for (const at of ["before-create", "created-unregistered", "registered", "verify"] as const) {
      const { email, made } = await keptSignup(at);
      const before = await findable(made.id);
      await retryNow(email);
      expect(await findable(made.id), at).toBe(before);
      await neverLost(made.id);
    }
  });

  it("an attempt still in flight whose account a retry removed cleans up after itself", async () => {
    const { id, email } = await newAccount();
    const made = { id: "" };
    let retried: { id: string } | undefined;
    const result = await provisionNewAccount(id, email, {
      provision: async (tenantId, opts) => {
        made.id = tenantId;
        await provisionTenant(tenantId, opts);
        retried = await registerUser(getCatalogDb(), { email, password: PASSWORD }); // the person pressed again
      },
    });
    expect(result).toEqual(removedAnswer("removed"));
    expect(existsSync(tenantFile(made.id))).toBe(false);
    expect(await registered(made.id)).toBe(false);
    expect(await findable(made.id)).toBe(false);
    expect((await provisionNewAccount(retried!.id, email)).ok).toBe(true);
  });

  it("an unfinished account's password-reset token goes with it, and the retry works", async () => {
    const { id, email } = await keptSignup();
    await query("INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)", [
      `tok-${id}`,
      id,
      `hash-${id}`,
      Math.floor(Date.now() / 1000) + 3600,
    ]);
    await retryNow(email);
    expect(await query("SELECT id FROM password_reset_tokens WHERE user_id = ?", [id])).toHaveLength(0);
  });

  it("a retry never takes over a switched-on account: told to sign in, the account unchanged", async () => {
    const on = await activeAccount();
    const before = await getUserById(getCatalogDb(), on.id);
    await expect(registerUser(getCatalogDb(), { email: on.email, password: PASSWORD })).rejects.toThrow(ACCOUNT_EXISTS_MESSAGE);
    expect(await getUserById(getCatalogDb(), on.id)).toEqual(before);
  });

  it("a retry never takes over a closed account: told to sign in, the account unchanged", async () => {
    const closed = await activeAccount();
    await query("UPDATE users SET deactivated_at = unixepoch(), deletion_due_at = unixepoch() + 86400 WHERE id = ?", [closed.id]);
    const before = await getUserById(getCatalogDb(), closed.id);
    await expect(registerUser(getCatalogDb(), { email: closed.email, password: PASSWORD })).rejects.toThrow(ACCOUNT_EXISTS_MESSAGE);
    expect(await getUserById(getCatalogDb(), closed.id)).toEqual(before);
  });

  it("a sign-up account linked to a tenant is never taken over: the fixed message, nothing touched", async () => {
    const owner = await inviter();
    const { id, email } = await newAccount();
    await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, id]);
    await expect(registerUser(getCatalogDb(), { email, password: PASSWORD })).rejects.toThrow(SignupRetryError);
    expect((await account(id)).tenant_id).toBe(owner.tenantId);
    await untouched(owner);
  });

  it("two retries at the same moment: exactly one takes the account over, the other is told to try again", async () => {
    for (let round = 0; round < 3; round++) {
      const { id, email } = await keptSignup();
      // Both retries have read the unfinished account before either writes: the
      // catalog holds each one's write until both have reached it.
      const real = getCatalogDb();
      let waiting = 0;
      let release: () => void = () => {};
      const bothThere = new Promise<void>((r) => (release = r));
      const catalog = new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "batch") {
            return async (...args: unknown[]) => {
              if (++waiting === 2) release();
              await bothThere;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as AppDatabase;
      const outcomes = await Promise.allSettled([
        registerUser(catalog, { email, password: PASSWORD }),
        registerUser(catalog, { email, password: PASSWORD }),
      ]);
      const won = outcomes.filter((o) => o.status === "fulfilled");
      const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0].reason).toBeInstanceOf(SignupRetryError);
      expect(lost[0].reason.message).toBe(SIGNUP_FAILED_MESSAGE);
      const winner = (won[0] as PromiseFulfilledResult<{ id: string }>).value;
      expect(await getUserById(getCatalogDb(), id)).toBeUndefined();
      expect(await query("SELECT id FROM users WHERE email = ?", [email])).toEqual([expect.objectContaining({ id: winner.id })]);
      expect((await provisionNewAccount(winner.id, email)).ok).toBe(true);
    }
  });

  it("no answer to a failed sign-up mentions an hour or asks the person to wait", async () => {
    for (const a of ["removed", "kept", "exists", "unknown"]) {
      for (const d of ["none", "removed", "listed-for-sweep"]) {
        const r = signupFailure(a as SignupProvisionFailure["account"], d as SignupProvisionFailure["database"]);
        expect(r.message).toBe("Something went wrong creating your account. Please try again.");
        expect(r.message).not.toMatch(/hour|minute|wait/i);
      }
    }
    expect(SIGNUP_PROVISION_FAILED_MESSAGE).toBe(SIGNUP_FAILED_MESSAGE);
    expect(new SignupRetryError().message).toBe(SIGNUP_FAILED_MESSAGE);
    expect(SIGNUP_FAILED_RETRY_SECONDS).toBeLessThanOrEqual(1);
  });
});

describe("erasure of finished accounts is as before", () => {
  it("a closed account that shares its workspace is erased alone; the last account's erasure then removes the workspace", async () => {
    const owner = await inviter();
    const member = await activeAccount();
    await query("UPDATE users SET tenant_id = ? WHERE id = ?", [owner.tenantId, member.id]);
    const removed: string[] = [];
    const first = await eraseAccount(getCatalogDb(), member.id, { tenantPlane: plane(removed) });
    expect(first?.tenantKept).toBe("linked-by-another-account");
    expect(removed).toHaveLength(0);
    await untouched(owner);
    const last = await eraseAccount(getCatalogDb(), owner.id, { tenantPlane: plane(removed) });
    expect(last?.tenantKept).toBeNull();
    expect(last?.tenantDatabase).toBe("removed");
    expect(removed).toEqual([owner.tenantId]);
    expect(await registered(owner.tenantId)).toBe(false);
  });
});
