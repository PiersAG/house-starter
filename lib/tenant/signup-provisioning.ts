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
//                               registration and the account are deleted, so the
//                               address is free to sign up again; the database,
//                               if one was made, is deleted, or listed in
//                               tenant_orphans for the factory's sweep when the
//                               delete is refused;
//   never a crash             — the caller gets { ok: false } and shows a plain
//                               message; nothing is thrown at it.

import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { getCatalogDb } from "@/lib/catalog";
import { getTenancyMode, resolveTenant } from "@/lib/db";
import { logEvent } from "@/lib/observability/log";
import { tenants, users } from "@/lib/schema";
import { ensureTenantForUser, getProvisioner, newTenantId } from "@/lib/tenant/provisioner";
import { recordTenantOrphan } from "@/lib/tenant/orphans";
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

/**
 * Give a just-registered account its own database, or undo the sign-up.
 * `userId` must be an account created moments ago by this same sign-up.
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

  try {
    // The tenant id is linked to the account BEFORE its database is made, so a
    // failure at any later step — even after Turso has made the database —
    // leaves a rollback that knows which database to delete. ensureTenantForUser
    // sees a linked id with no registration and provisions under that same id.
    await catalog
      .update(users)
      .set({ tenantId: newTenantId() })
      .where(and(eq(users.id, userId), isNull(users.tenantId)))
      .run();
    const tenantId = await ensureTenant(userId, { label, env });
    await verifyRoute(tenantId);
    return { ok: true, tenantId };
  } catch (error) {
    console.error("signup: the account's database could not be set up; rolling the sign-up back", error);
    const database = await rollBack(catalog, userId, env, deps.destroy);
    logEvent({
      level: "error",
      event: "signup.provision_failed",
      userId,
      fields: { database },
    });
    return { ok: false, database };
  }
}

async function rollBack(
  catalog: AppDatabase,
  userId: string,
  env: NodeJS.ProcessEnv,
  destroyOverride?: (tenantId: string) => Promise<boolean>,
): Promise<"none" | "removed" | "listed-for-sweep"> {
  const rows = await catalog
    .select({ tenantId: users.tenantId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();
  const tenantId = rows[0]?.tenantId ?? null;

  // The account and its registration go first, so the address is free again
  // whatever happens to the database below.
  await catalog.delete(users).where(eq(users.id, userId)).run();

  // No linked id: the very first write failed, so nothing was made.
  if (!tenantId) return "none";
  // ensureTenantForUser registers the tenant (the `tenants` row) only after its
  // database is made and migrated, so the row may or may not exist here.
  await catalog.delete(tenants).where(eq(tenants.id, tenantId)).run();

  let removed = false;
  try {
    removed = await (destroyOverride ?? ((id: string) => getProvisioner(env).destroy(id)))(tenantId);
  } catch (error) {
    console.error("signup: deleting the rolled-back database failed", error);
  }
  if (removed) return "removed";
  await recordTenantOrphan(tenantId, "signup-rollback", catalog);
  return "listed-for-sweep";
}
