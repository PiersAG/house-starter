// A new account's own database, all or nothing (app-business-core issue 358).
//
// The requirement, word for word: "on real customer signup, create that
// customer's own isolated DB, migrate it, register TENANT_DB_URL_<key> and
// connect per_tenant WITH graceful retry and error handling - NEVER a
// half-created account, never a crash." (The catalog's `tenants` row replaced
// TENANT_DB_URL_<key> when the routing seam landed: it is the registration.)
//
//   create, migrate, register — ensureTenantForUser (lib/tenant/provisioner.ts),
//                               whose Turso calls retry Turso's passing errors;
//   connect                   — the new database is opened through the catalog's
//                               route, exactly as the first signed-in page will
//                               open it, and its own tenant row is read back;
//   never half-created        — the account is created SWITCHED OFF
//                               (lib/users.ts registerUser: sign-in refuses it)
//                               and switched on here only after its tenant and
//                               database are fully provisioned and open, so no
//                               failure, not even of every rollback step, leaves
//                               a usable account without a database. Any failure
//                               rolls the whole sign-up back: the account is
//                               deleted, so the address is free to sign up
//                               again, and the registration and the database
//                               this sign-up made are deleted, or the database
//                               is listed in tenant_orphans for the factory's
//                               sweep when the delete is refused;
//   never loses a database    — when the database cannot be listed, the
//                               account is NOT deleted: it is kept, switched
//                               off and due for erasure, so its link still
//                               names the database and the retention job
//                               erases the two together;
//   only its own              — the rollback touches a tenant row or database
//                               only when it is the id THIS sign-up minted and
//                               linked, and no account links it any more; an
//                               account that already held a tenant (an invited
//                               member, a re-link) is never rolled back into
//                               someone else's workspace — when it is switched
//                               on and its workspace opens, it is already set up
//                               and the person is signed in. The minted id is
//                               recorded on the account (users.signup_tenant_id),
//                               so the retention job's erasure of an unfinished
//                               sign-up removes only the database the sign-up
//                               made (lib/privacy/deletion.ts eraseAccount);
//   never a crash             — the caller gets { ok: false } and shows a plain
//                               message; nothing is thrown at it, even when a
//                               rollback step itself fails (each is guarded and
//                               logged by name).

import "server-only";

import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { getCatalogDb } from "@/lib/catalog";
import { getTenancyMode, resolveTenant } from "@/lib/db";
import { logEvent } from "@/lib/observability/log";
import { tenants, users } from "@/lib/schema";
import { ensureTenantForUser, getProvisioner, newTenantId } from "@/lib/tenant/provisioner";
import { clearTenantOrphan, recordTenantOrphan } from "@/lib/tenant/orphans";
import type { AppDatabase } from "@/lib/users";

export type SignupProvisionResult =
  | {
      ok: true;
      tenantId: string;
      /** The account already had a working workspace (an invited member): nothing was made. */
      alreadySetUp?: true;
    }
  | {
      ok: false;
      /**
       * What the rollback did with a database that had been made:
       * "kept-with-account" — it could not be listed, so the account was kept,
       * switched off and due for erasure, its link naming the database.
       */
      database: "none" | "removed" | "listed-for-sweep" | "kept-with-account";
    };

/**
 * What a customer reads when it fails. The account is gone afterwards, or (when
 * its database could not be listed) kept switched off until the retention job
 * erases it: either way nothing usable was saved.
 */
export const SIGNUP_PROVISION_FAILED_MESSAGE =
  "We could not finish setting up your account, so nothing was saved. " +
  "Please try again in a minute.";

export interface SignupProvisionDeps {
  catalog?: AppDatabase;
  env?: NodeJS.ProcessEnv;
  ensureTenant?: typeof ensureTenantForUser;
  verifyRoute?: (tenantId: string) => Promise<void>;
  destroy?: (tenantId: string) => Promise<boolean>;
}

/**
 * Open the tenant's database by the catalog's route and read its own row back.
 * Throws when the route does not lead to a migrated database for this tenant.
 */
export async function verifyTenantRoute(tenantId: string): Promise<void> {
  if (getTenancyMode() !== "per_tenant") return;
  const { url, authToken } = await resolveTenant(tenantId);
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url, authToken });
  try {
    const r = await client.execute({
      sql: "SELECT tenant_id FROM tenant_meta WHERE tenant_id = ? LIMIT 1",
      args: [tenantId],
    });
    if (r.rows.length !== 1) {
      throw new Error(`the database the catalog routes ${tenantId} to does not hold its tenant row`);
    }
  } finally {
    client.close();
  }
}

/** The rollback steps, by name, as they appear in the log when one fails. */
export type RollbackStep =
  | "read-link"
  | "read-links"
  | "keep-account"
  | "record-orphan"
  | "delete-account"
  | "deactivate-account"
  | "delete-registration"
  | "delete-database"
  | "clear-orphan";

/**
 * Give a just-registered account its own database, or undo the sign-up.
 * The account must hold no tenant yet: the link below is made only on an
 * account with none, and anything else stops before a database is made.
 */
export async function provisionNewAccount(
  userId: string,
  label: string | null,
  deps: SignupProvisionDeps = {},
): Promise<SignupProvisionResult> {
  const catalog = deps.catalog ?? getCatalogDb();
  const env = deps.env ?? process.env;
  const ensureTenant = deps.ensureTenant ?? ensureTenantForUser;
  const verifyRoute = deps.verifyRoute ?? verifyTenantRoute;
  // The id this sign-up owns. Only this id is ever rolled back.
  const minted = newTenantId();

  let linked = false;
  try {
    // The tenant id is linked to the account BEFORE its database is made, so a
    // failure at any later step — even after Turso has made the database —
    // leaves a rollback that knows which database to delete. ensureTenantForUser
    // sees a linked id with no registration and provisions under that same id.
    //
    // Only an account that is switched on or is a sign-up being set up: an
    // account its owner closed is never given a workspace or switched back on.
    const link = await catalog
      .update(users)
      .set({ tenantId: minted, signupTenantId: minted })
      .where(and(eq(users.id, userId), isNull(users.tenantId), switchable()))
      .run();
    if (link.rowsAffected !== 1) {
      // No such account, or it already holds a tenant (an invited member, a
      // re-link): not a fresh sign-up. Nothing was made, so nothing is undone —
      // above all not the tenant the account already belongs to. Such an
      // account, if still a sign-up being set up, holds no signup_tenant_id, so
      // when its hour is up the retention job erases the account alone and
      // leaves that tenant and its database as they are.
      if (link.rowsAffected === 0) {
        const existing = await alreadySetUp(catalog, userId, verifyRoute);
        if (existing) return { ok: true, tenantId: existing, alreadySetUp: true };
      }
      const reason = link.rowsAffected === 0 ? "account-missing-or-already-linked" : "link-changed-several-rows";
      console.error(`signup: the account's database was not set up (${reason}); nothing rolled back`);
      try {
        logEvent({ level: "error", event: "signup.provision_refused", userId, fields: { reason } });
      } catch {
        // logEvent never throws by design; nothing more to do here.
      }
      return { ok: false, database: "none" };
    }
    linked = true;
    const tenantId = await ensureTenant(userId, { label, env });
    if (tenantId !== minted) {
      throw new Error("ensureTenantForUser answered a different tenant than the one this sign-up linked");
    }
    await verifyRoute(tenantId);
    // Only now, with its tenant registered and its database open, is the
    // account switched on. Until this row changes, sign-in refuses it.
    const on = await catalog
      .update(users)
      .set({ signupPendingSince: null, signupTenantId: null, deactivatedAt: null, deletionDueAt: null })
      .where(and(eq(users.id, userId), eq(users.tenantId, minted), switchable()))
      .run();
    if (on.rowsAffected !== 1) {
      throw new Error("the account could not be switched on after its database was set up");
    }
    return { ok: true, tenantId };
  } catch (error) {
    console.error("signup: the account's database could not be set up; rolling the sign-up back", error);
    const { database, failed } = await rollBack(catalog, userId, linked ? minted : null, env, deps.destroy);
    try {
      logEvent({
        level: "error",
        event: failed.length ? "signup.rollback_incomplete" : "signup.provision_failed",
        userId,
        // An incomplete rollback names the tenant id, so whatever is left can be found.
        fields: failed.length
          ? { database, failedSteps: failed.join(","), tenantId: linked ? minted : "none" }
          : { database },
      });
    } catch (logError) {
      console.error("signup: rollback step log-event failed", logError);
    }
    return { ok: false, database };
  }
}

/** A row this sign-up may link and switch on: switched on already, or a sign-up being set up — never a closed account. */
function switchable() {
  return or(isNull(users.deactivatedAt), isNotNull(users.signupPendingSince));
}

/**
 * The account already belongs to a working workspace — switched on (not a
 * sign-up being set up, not closed), its tenant registered, and its database
 * opening by the catalog's route. Then there is nothing to set up and the
 * person can sign in: its tenant id. Otherwise null. Never throws.
 */
async function alreadySetUp(
  catalog: AppDatabase,
  userId: string,
  verifyRoute: (tenantId: string) => Promise<void>,
): Promise<string | null> {
  try {
    const [row] = await catalog
      .select({ tenantId: users.tenantId, deactivatedAt: users.deactivatedAt, signupPendingSince: users.signupPendingSince })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .all();
    if (!row?.tenantId || row.deactivatedAt || row.signupPendingSince) return null;
    const registered = await catalog
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, row.tenantId))
      .limit(1)
      .all();
    if (registered.length !== 1) return null;
    await verifyRoute(row.tenantId);
    return row.tenantId;
  } catch (error) {
    console.error("signup: could not confirm the account's existing workspace", error);
    return null;
  }
}

/** Run one rollback step; a throw is logged by the step's name, never passed on. */
async function step<T>(name: RollbackStep, failed: RollbackStep[], run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    failed.push(name);
    console.error(`signup: rollback step ${name} failed`, error);
    return undefined;
  }
}

/**
 * Undo a sign-up. `minted` is the tenant id this sign-up linked (null when the
 * link itself never happened). The order keeps track of the database throughout:
 *
 *   1 read the account's link: is it still `minted`?
 *   2 list `minted` in tenant_orphans whenever this sign-up linked it, whatever
 *     the account's link says now (a re-link part-way still leaves the
 *     database Turso made under `minted`): from here it cannot be lost, and
 *     the sweep checks again before deleting;
 *   3 if it could NOT be listed while the account still names it, keep the
 *     account: switched off with its erasure due now, its link is the record
 *     of the database, and the retention job erases the two together. Nothing
 *     more is touched;
 *   4 otherwise delete the account; if that fails, deactivate it with its
 *     erasure due now (sign-in refused; the retention job erases it and its
 *     database), and leave its registration and database alone, so it is never
 *     an account linked to a tenant with no database;
 *   5 only when no account links `minted` (read again, after the account is
 *     gone), delete the database; then its registration once the database is
 *     gone or listed; and take it off the list once it is gone.
 *
 * The account was created switched off, so even if every step here fails it
 * stays off: never a usable account linked to a tenant with no database.
 */
async function rollBack(
  catalog: AppDatabase,
  userId: string,
  minted: string | null,
  env: NodeJS.ProcessEnv,
  destroyOverride?: (tenantId: string) => Promise<boolean>,
): Promise<{ database: Extract<SignupProvisionResult, { ok: false }>["database"]; failed: RollbackStep[] }> {
  const failed: RollbackStep[] = [];
  const done = async (name: RollbackStep, run: () => Promise<unknown>) =>
    (await step(name, failed, async () => {
      await run();
      return true;
    })) === true;

  // ours: the account is gone or still linked to `minted`. unsure: the link
  // could not be read. Either way, and also when the account was re-linked,
  // the database is listed: listing deletes nothing, and the sweep checks
  // again. It is deleted below only once no account links `minted`.
  let ours = false;
  let unsure = false;
  if (minted) {
    const rows = await step("read-link", failed, () =>
      catalog.select({ tenantId: users.tenantId }).from(users).where(eq(users.id, userId)).limit(1).all(),
    );
    unsure = rows === undefined;
    ours = rows !== undefined && (rows.length === 0 || rows[0].tenantId === minted);
    if (rows !== undefined && !ours) {
      console.error("signup: the account is linked to another tenant now; that tenant and its database are left alone");
    }
  }

  const listed = minted !== null
    ? await done("record-orphan", () => recordTenantOrphan(minted, "signup-rollback", catalog))
    : false;

  const now = new Date();
  const switchOff = () =>
    catalog
      .update(users)
      .set({ deactivatedAt: now, deletionDueAt: now, sessionsValidFrom: now })
      .where(eq(users.id, userId))
      .run();

  // A database may exist under `minted` (Turso may have made it before the
  // failure, even with no `tenants` row yet) and the list could not record it:
  // the account's link is then the only record of its name, so the account is
  // kept, never deleted. It was created switched off; this makes its erasure
  // due now, and the retention job erases it with the database it names.
  if (minted && (ours || unsure) && !listed) {
    await done("keep-account", switchOff);
    return { database: "kept-with-account", failed };
  }

  if (!(await done("delete-account", () => catalog.delete(users).where(eq(users.id, userId)).run()))) {
    await done("deactivate-account", switchOff);
    // Its registration and database stay: the erasure job removes them with it.
    return { database: listed ? "listed-for-sweep" : "none", failed };
  }

  if (!minted) return { database: "none", failed };
  // `minted` is a fresh random id only this sign-up held, but its database is
  // deleted only when the catalog shows no account linking it now — read after
  // the account itself is gone. An unreadable answer deletes nothing: the
  // database stays listed for the sweep, which checks again.
  const free = await step("read-links", failed, async () =>
    (await catalog.select({ id: users.id }).from(users).where(eq(users.tenantId, minted)).limit(1).all()).length === 0,
  );
  if (free !== true) {
    if (free === false) console.error("signup: an account links the minted tenant; its database is left alone");
    return { database: listed ? "listed-for-sweep" : "none", failed };
  }
  const destroy = destroyOverride ?? ((id: string) => getProvisioner(env).destroy(id));
  const removed = (await step("delete-database", failed, () => destroy(minted))) === true;
  // ensureTenantForUser registers the tenant (the `tenants` row) only after its
  // database is made and migrated, so the row may or may not exist here. It is
  // deleted once the database is gone or listed; otherwise it is the one record
  // left of where the database is, and stays.
  if (removed || listed) {
    await done("delete-registration", () => catalog.delete(tenants).where(eq(tenants.id, minted)).run());
  }
  if (removed) {
    if (listed) await done("clear-orphan", () => clearTenantOrphan(minted, catalog));
    return { database: "removed", failed };
  }
  return { database: listed ? "listed-for-sweep" : "none", failed };
}
