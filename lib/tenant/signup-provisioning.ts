// A new account's own database, all or nothing (app-business-core issue 358).
//
// The requirement, word for word: "on real customer signup, create that
// customer's own isolated DB, migrate it, register TENANT_DB_URL_<key> and
// connect per_tenant WITH graceful retry and error handling - NEVER a
// half-created account, never a crash." (The catalog's `tenants` row replaced
// TENANT_DB_URL_<key> when the routing seam landed: it is the registration.)
//
// RECORD FIRST, THEN CREATE (Dispatch AG-fix4). Every way a made database could
// be lost came from finding it through the account or its link, both of which a
// failure can change. So the database is never found that way:
//
//   1 record  — the tenant id this sign-up mints is written to tenant_orphans
//               ("signup") BEFORE Turso is asked for anything. If that write
//               fails, no database is made. From here the database can always
//               be found by that record, whatever happens to the account;
//   2 create, migrate, register — provisionTenant (lib/tenant/provisioner.ts),
//               under the recorded id only; its Turso calls retry Turso's
//               passing errors;
//   3 connect — the database is opened through the catalog's route, exactly as
//               the first signed-in page will open it, and its own row read back;
//   4 switch on — ONE atomic write links the account to its tenant, switches it
//               on and deletes the record. Until then the account is switched
//               off (lib/users.ts registerUser creates it so) and linked to
//               nothing, so no failure leaves a usable account without a
//               database, and none leaves a link pointing at a half-made one.
//
// On any failure the rollback deletes the account (only while it is still a
// sign-up being set up), then — only once the catalog shows no account linking
// the id — the database, its registration and the record. Whatever it cannot
// delete stays recorded: the factory's sweep (app-business-core
// agents/tenant_db_sweep.py) deletes it later, after reading again that no
// account links it. An account the rollback could not delete stays switched
// off; it is erased an hour after it was made, as an account only (its database
// is the sweep's, through the record — lib/privacy/deletion.ts tenantErasable).
//
// Never a crash: the caller gets { ok: false } with the message that is true
// for what was left, and nothing is thrown at it.

import "server-only";

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getCatalogDb } from "@/lib/catalog";
import { getTenancyMode, resolveTenant } from "@/lib/db";
import { logEvent } from "@/lib/observability/log";
import { tenantOrphans, tenants, users } from "@/lib/schema";
import { getProvisioner, newTenantId, provisionTenant } from "@/lib/tenant/provisioner";
import { recordTenantOrphan } from "@/lib/tenant/orphans";
import { ACCOUNT_EXISTS_MESSAGE, PENDING_SIGNUP_RETRY_SECONDS, type AppDatabase } from "@/lib/users";

/** The account is gone, so the address is free again at once. */
export const SIGNUP_PROVISION_FAILED_MESSAGE =
  "We could not finish setting up your account, so nothing was saved. " +
  "Please try again in a minute.";

/**
 * The account still exists, switched off. A retry within the hour is told the
 * same (lib/users.ts registerUser); after the hour the retry erases it and
 * signs up afresh.
 */
export const SIGNUP_STILL_BEING_SET_UP_MESSAGE =
  "Your account is still being set up. Please try again in an hour.";

/**
 * For a failure whose outcome is not known (an unexpected error in a route):
 * true whichever way it went, as after an hour a retry always gets through.
 */
export const SIGNUP_UNSURE_MESSAGE =
  "We could not finish setting up your account. Please try again in an hour.";

export const SIGNUP_FAILED_RETRY_SECONDS = 60;
export const SIGNUP_UNSURE_RETRY_SECONDS = PENDING_SIGNUP_RETRY_SECONDS;

export type SignupProvisionFailure = {
  ok: false;
  /**
   * What became of the account, so the answer is true and agrees with a retry:
   * "removed" — gone, the address free at once; "kept" — still a sign-up being
   * set up, switched off, until it is erased an hour after it was made;
   * "exists" — a finished (or closed) account, which a retry is told to sign in
   * to; "unknown" — it could not be read.
   */
  account: "removed" | "kept" | "exists" | "unknown";
  /**
   * "none" — no database was asked for; "removed" — it was made and is gone;
   * "listed-for-sweep" — it may exist, and its tenant_orphans record stays.
   */
  database: "none" | "removed" | "listed-for-sweep";
  /** What to tell the person: true for what was left. */
  message: string;
  retryAfterSeconds: number;
};

export type SignupProvisionResult =
  | {
      ok: true;
      tenantId: string;
      /** The account already had a working workspace (an invited member): nothing was made. */
      alreadySetUp?: true;
    }
  | SignupProvisionFailure;

export interface SignupProvisionDeps {
  catalog?: AppDatabase;
  env?: NodeJS.ProcessEnv;
  /** Create, migrate and register the database for this id (provisionTenant). */
  provision?: (tenantId: string, opts: { label: string | null; env: NodeJS.ProcessEnv }) => Promise<unknown>;
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
  | "delete-account"
  | "read-account"
  | "read-links"
  | "delete-database"
  | "delete-registration"
  | "clear-record";

/** The failure answer for what the rollback left. */
export function signupFailure(
  account: SignupProvisionFailure["account"],
  database: SignupProvisionFailure["database"],
): SignupProvisionFailure {
  const [message, retryAfterSeconds] = {
    removed: [SIGNUP_PROVISION_FAILED_MESSAGE, SIGNUP_FAILED_RETRY_SECONDS],
    kept: [SIGNUP_STILL_BEING_SET_UP_MESSAGE, PENDING_SIGNUP_RETRY_SECONDS],
    exists: [ACCOUNT_EXISTS_MESSAGE, SIGNUP_FAILED_RETRY_SECONDS],
    unknown: [SIGNUP_UNSURE_MESSAGE, SIGNUP_UNSURE_RETRY_SECONDS],
  }[account] as [string, number];
  return { ok: false, account, database, message, retryAfterSeconds };
}

/** What the account is now, read from its row (undefined: no such account). */
function accountState(row: { signupPendingSince: Date | null } | undefined): SignupProvisionFailure["account"] {
  if (!row) return "removed";
  return row.signupPendingSince !== null ? "kept" : "exists";
}

/**
 * Give a just-registered account its own database, or undo the sign-up.
 * Only an account still being set up and linked to no tenant is given one.
 */
export async function provisionNewAccount(
  userId: string,
  label: string | null,
  deps: SignupProvisionDeps = {},
): Promise<SignupProvisionResult> {
  const catalog = deps.catalog ?? getCatalogDb();
  const env = deps.env ?? process.env;
  const provision = deps.provision ?? provisionTenant;
  const verifyRoute = deps.verifyRoute ?? verifyTenantRoute;
  let minted: string | null = null;
  let recorded = false;
  try {
    const [row] = await catalog
      .select({ tenantId: users.tenantId, signupPendingSince: users.signupPendingSince })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .all();
    if (!row || row.tenantId !== null || row.signupPendingSince === null) {
      // Not a fresh sign-up: no such account, or it already holds a tenant (an
      // invited member), or it is switched on or closed. Nothing is made or undone.
      const existing = row ? await alreadySetUp(catalog, userId, verifyRoute) : null;
      if (existing) return { ok: true, tenantId: existing, alreadySetUp: true };
      const reason = row ? "account-not-a-fresh-sign-up" : "account-missing";
      console.error(`signup: the account's database was not set up (${reason}); nothing made or rolled back`);
      safeLog({ level: "error", event: "signup.provision_refused", userId, fields: { reason } });
      return signupFailure(accountState(row), "none");
    }

    // 1 record first: if this fails, the catch below deletes the account and nothing else.
    minted = newTenantId();
    await recordTenantOrphan(minted, "signup", catalog);
    recorded = true;
    // 2 and 3: the database, under the recorded id only, opened by the catalog's route.
    await provision(minted, { label, env });
    await verifyRoute(minted);
    // 4 link, switch on and drop the record, in one write.
    await switchOn(catalog, userId, minted);
    return { ok: true, tenantId: minted };
  } catch (error) {
    console.error("signup: the account's database could not be set up; rolling the sign-up back", error);
    const id = recorded ? minted : null;
    const { account, database, failed } = await rollBack(catalog, userId, id, env, deps.destroy);
    safeLog({
      level: "error",
      event: failed.length ? "signup.rollback_incomplete" : "signup.provision_failed",
      userId,
      // An incomplete rollback names the tenant id, so whatever is left can be found.
      fields: failed.length ? { account, database, failedSteps: failed.join(","), tenantId: id ?? "none" } : { account, database },
    });
    return signupFailure(account, database);
  }
}

function safeLog(event: Parameters<typeof logEvent>[0]): void {
  try {
    logEvent(event);
  } catch (logError) {
    console.error("signup: log-event failed", logError);
  }
}

/**
 * Link the account to `minted`, switch it on and delete the sign-up's record,
 * atomically (one batch: both writes or neither). The record goes only once the
 * account is on and linked to `minted`. When the write's answer is lost, the
 * account is read back: switched on and linked is a success.
 */
async function switchOn(catalog: AppDatabase, userId: string, minted: string): Promise<void> {
  let changed: number;
  try {
    const [on] = await catalog.batch([
      catalog
        .update(users)
        .set({ tenantId: minted, signupPendingSince: null, deactivatedAt: null, deletionDueAt: null })
        .where(and(eq(users.id, userId), isNull(users.tenantId), isNotNull(users.signupPendingSince))),
      catalog
        .delete(tenantOrphans)
        .where(
          and(
            eq(tenantOrphans.tenantId, minted),
            sql`exists (select 1 from users where users.id = ${userId} and users.tenant_id = ${minted} and users.signup_pending_since is null)`,
          ),
        ),
    ]);
    changed = on.rowsAffected;
  } catch (error) {
    if (await isOn(catalog, userId, minted)) return;
    throw error;
  }
  if (changed !== 1) throw new Error("the account could not be switched on after its database was set up");
}

async function isOn(catalog: AppDatabase, userId: string, minted: string): Promise<boolean> {
  try {
    const [row] = await catalog
      .select({ tenantId: users.tenantId, signupPendingSince: users.signupPendingSince })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .all();
    return row?.tenantId === minted && row.signupPendingSince === null;
  } catch {
    return false;
  }
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
 * Undo a sign-up. `minted` is the recorded tenant id (null when the record was
 * never written, so no database was asked for). Each step runs only if the one
 * before it succeeded; whatever is not deleted keeps its record:
 *
 *   1 delete the account, only while it is still a sign-up being set up (if it
 *     is not, it is read, so the answer says what it is);
 *   2 read who links `minted`: nobody, or stop;
 *   3 delete the database: gone, or stop;
 *   4 delete its registration, then 5 its record.
 */
async function rollBack(
  catalog: AppDatabase,
  userId: string,
  minted: string | null,
  env: NodeJS.ProcessEnv,
  destroyOverride?: (tenantId: string) => Promise<boolean>,
): Promise<{
  account: SignupProvisionFailure["account"];
  database: SignupProvisionFailure["database"];
  failed: RollbackStep[];
}> {
  const failed: RollbackStep[] = [];
  const deleted = await step("delete-account", failed, () =>
    catalog
      .delete(users)
      .where(and(eq(users.id, userId), isNotNull(users.signupPendingSince)))
      .run(),
  );
  // Deleted; or not deleted because it is no longer a sign-up being set up (read
  // it, so the answer says what it is); or the delete failed, leaving it as it was.
  let account: SignupProvisionFailure["account"] = "kept";
  if (deleted?.rowsAffected === 1) account = "removed";
  else if (deleted !== undefined) {
    const rows = await step("read-account", failed, () =>
      catalog.select({ signupPendingSince: users.signupPendingSince }).from(users).where(eq(users.id, userId)).limit(1).all(),
    );
    account = rows === undefined ? "unknown" : accountState(rows[0]);
  }
  if (!minted) return { account, database: "none", failed };

  const left = { account, database: "listed-for-sweep" as const, failed };
  const free = await step("read-links", failed, async () =>
    (await catalog.select({ id: users.id }).from(users).where(eq(users.tenantId, minted)).limit(1).all()).length === 0,
  );
  if (free !== true) return left;
  const destroy = destroyOverride ?? ((id: string) => getProvisioner(env).destroy(id));
  if ((await step("delete-database", failed, () => destroy(minted))) !== true) return left;
  const unregistered = await step("delete-registration", failed, () =>
    catalog.delete(tenants).where(eq(tenants.id, minted)).run(),
  );
  // The record goes last, once nothing it leads to is left.
  if (unregistered !== undefined) {
    await step("clear-record", failed, () => catalog.delete(tenantOrphans).where(eq(tenantOrphans.tenantId, minted)).run());
  }
  return { account, database: "removed", failed };
}
