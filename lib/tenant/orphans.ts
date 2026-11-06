// Customer databases left behind (app-business-core issues 358 and 857).
//
// Two paths can leave a hosted database that no account points to: a sign-up
// rolled back after its database was made, and an erased account whose database
// Turso would not delete. Both try to delete it first. When that delete is
// refused — the app's own key holds no delete right once each app has its own
// limited key (#439) — the tenant id is written to `tenant_orphans`, and the
// factory's daily erase job (app-business-core .github/workflows/tenant-erase.yml,
// agents/tenant_db_sweep.py `erase`) deletes the database with a key that can
// delete and nothing else. That job only READS the catalog; this app then sees
// the database is gone and clears the row itself (settleTenantOrphans, run by
// the daily retention job). A leftover is therefore always listed, never lost.

import "server-only";

import { and, eq, isNull, notExists } from "drizzle-orm";
import type { AppDatabase } from "@/lib/users";
import { getCatalogDb } from "@/lib/catalog";
import { tenantOrphans, tenants, users } from "@/lib/schema";

export type OrphanReason = "signup" | "erasure";

/** List a database that still needs deleting. Repeating it keeps the first entry. */
export async function recordTenantOrphan(
  tenantId: string,
  reason: OrphanReason,
  db: AppDatabase = getCatalogDb(),
): Promise<void> {
  await db
    .insert(tenantOrphans)
    .values({ tenantId, reason })
    .onConflictDoNothing({ target: tenantOrphans.tenantId })
    .run();
}

/** Databases still waiting for the sweep. */
export async function pendingTenantOrphans(
  db: AppDatabase = getCatalogDb(),
): Promise<string[]> {
  const rows = await db
    .select({ tenantId: tenantOrphans.tenantId })
    .from(tenantOrphans)
    .where(isNull(tenantOrphans.clearedAt))
    .all();
  return rows.map((r) => r.tenantId);
}

/** Mark one as deleted (the sweep does this; tests use it). */
export async function clearTenantOrphan(
  tenantId: string,
  db: AppDatabase = getCatalogDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(tenantOrphans)
    .set({ clearedAt: now })
    .where(eq(tenantOrphans.tenantId, tenantId))
    .run();
}

/**
 * A `signup` row is left alone for its first hour: the sign-up writes it before
 * it asks Turso for the database, so "no database yet" is normal then. The
 * factory's erase job waits the same hour (agents/tenant_db_sweep.py).
 */
export const SIGNUP_GRACE_MS = 60 * 60 * 1000;

export interface SettleResult {
  /** Rows cleared because their database is gone. */
  cleared: string[];
  /** Rows whose database still exists: still waiting for the factory's job. */
  waiting: string[];
  /** Rows the platform gave no clear answer for: left as they are. */
  unknown: string[];
}

/**
 * Clear every listed database the platform says is gone (Dispatch AO). The
 * factory's erase job deletes with a delete-only key and never writes the
 * catalog, so the app records the outcome: a `signup` row's registration is
 * removed too, but only while no account links the tenant, and the row is then
 * marked cleared. Nothing is deleted at the platform here, and a row is cleared
 * only on a plain "not there" (404), never on an error.
 */
export async function settleTenantOrphans(
  exists: (tenantId: string) => Promise<boolean>,
  db: AppDatabase = getCatalogDb(),
  now: Date = new Date(),
): Promise<SettleResult> {
  const rows = await db
    .select({ tenantId: tenantOrphans.tenantId, reason: tenantOrphans.reason, recordedAt: tenantOrphans.recordedAt })
    .from(tenantOrphans)
    .where(isNull(tenantOrphans.clearedAt))
    .all();
  const out: SettleResult = { cleared: [], waiting: [], unknown: [] };
  for (const r of rows) {
    if (r.reason === "signup" && now.getTime() - r.recordedAt.getTime() < SIGNUP_GRACE_MS) {
      out.waiting.push(r.tenantId);
      continue;
    }
    let present: boolean;
    try {
      present = await exists(r.tenantId);
    } catch (e) {
      console.error(`tenant orphans: could not check ${r.tenantId}`, e instanceof Error ? e.message : e);
      out.unknown.push(r.tenantId);
      continue;
    }
    if (present) {
      out.waiting.push(r.tenantId);
      continue;
    }
    if (r.reason === "signup") {
      await db
        .delete(tenants)
        .where(
          and(
            eq(tenants.id, r.tenantId),
            notExists(db.select({ id: users.id }).from(users).where(eq(users.tenantId, r.tenantId))),
          ),
        )
        .run();
    }
    await clearTenantOrphan(r.tenantId, db, now);
    out.cleared.push(r.tenantId);
  }
  return out;
}
