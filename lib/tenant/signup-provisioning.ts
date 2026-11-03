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
//   never half-created        — any failure rolls the whole sign-up back: the
//                               account is deleted, so the address is free to
//                               sign up again, and the registration and the
//                               database this sign-up made are deleted, or the
//                               database is listed in tenant_orphans for the
//                               factory's sweep when the delete is refused;
//   only its own              — the rollback touches a tenant row or database
//                               only when it is the id THIS sign-up minted and
//                               linked; an account that already held a tenant
//                               (an invited member, a re-link) is never rolled
//                               back into someone else's workspace;
//   never a crash             — the caller gets { ok: false } and shows a plain
//                               message; nothing is thrown at it, even when a
//                               rollback step itself fails (each is guarded and
//                               logged by name).

import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { getCatalogDb } from "@/lib/catalog";
import { getTenancyMode, resolveTenant } from "@/lib/db";
import { logEvent } from "@/lib/observability/log";
import { tenants, users } from "@/lib/schema";
import { ensureTenantForUser, getProvisioner, newTenantId } from "@/lib/tenant/provisioner";
import { clearTenantOrphan, recordTenantOrphan } from "@/lib/tenant/orphans";
import type { AppDatabase } from "@/lib/users";

export type SignupProvisionResult =
  | { ok: true; tenantId: string }
  | {
      ok: false;
      /** What the rollback did with a database that had been made. */
      database: "none" | "removed" | "listed-for-sweep";
    };

/** What a customer reads when it fails. The account does not exist afterwards. */
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
    const link = await catalog
      .update(users)
      .set({ tenantId: minted })
      .where(and(eq(users.id, userId), isNull(users.tenantId)))
      .run();
    if (link.rowsAffected !== 1) {
      // No such account, or it already holds a tenant (an invited member, a
      // re-link): not a fresh sign-up. Nothing was made, so nothing is undone —
      // above all not the tenant the account already belongs to.
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
 *   1 read the account's link, and act on the tenant only if it is still `minted`;
 *   2 list the database in tenant_orphans — from here it cannot be lost;
 *   3 delete the account; if that fails, deactivate it with its erasure due now
 *     (sign-in refused; the retention job erases it and its database), and leave
 *     its registration and database alone, so it is never an account linked to a
 *     tenant with no database;
 *   4 delete the database; then its registration once the database is gone or
 *     listed; and take it off the list once it is gone.
 */
async function rollBack(
  catalog: AppDatabase,
  userId: string,
  minted: string | null,
  env: NodeJS.ProcessEnv,
  destroyOverride?: (tenantId: string) => Promise<boolean>,
): Promise<{ database: "none" | "removed" | "listed-for-sweep"; failed: RollbackStep[] }> {
  const failed: RollbackStep[] = [];
  const done = async (name: RollbackStep, run: () => Promise<unknown>) =>
    (await step(name, failed, async () => {
      await run();
      return true;
    })) === true;

  // ours: the account is gone or still linked to `minted` — nobody else can hold
  // a fresh random id. unsure: the link could not be read; the database is then
  // listed (listing deletes nothing; the sweep checks again) but not deleted.
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

  const listed = minted !== null && (ours || unsure)
    ? await done("record-orphan", () => recordTenantOrphan(minted, "signup-rollback", catalog))
    : false;

  if (!(await done("delete-account", () => catalog.delete(users).where(eq(users.id, userId)).run()))) {
    const now = new Date();
    await done("deactivate-account", () =>
      catalog
        .update(users)
        .set({ deactivatedAt: now, deletionDueAt: now, sessionsValidFrom: now })
        .where(eq(users.id, userId))
        .run(),
    );
    // Its registration and database stay: the erasure job removes them with it.
    return { database: listed ? "listed-for-sweep" : "none", failed };
  }

  if (!ours || !minted) return { database: listed ? "listed-for-sweep" : "none", failed };
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
