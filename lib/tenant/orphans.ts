// Customer databases left behind (app-business-core issues 358 and 857).
//
// Two paths can leave a hosted database that no account points to: a sign-up
// rolled back after its database was made, and an erased account whose database
// Turso would not delete. Both try to delete it first. When that delete is
// refused — the app's own key holds no delete right once each app has its own
// limited key (#439) — the tenant id is written to `tenant_orphans`, and the
// factory's sweep (app-business-core agents/tenant_db_sweep.py) deletes the
// database with its own key. A leftover is therefore always listed, never lost.

import "server-only";

import { eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/lib/users";
import { getCatalogDb } from "@/lib/catalog";
import { tenantOrphans } from "@/lib/schema";

export type OrphanReason = "signup-rollback" | "erasure";

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
