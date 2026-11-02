// The retention job (app-business-core issues 722, 791, 352; Matt Murphy #156:
// "after 30 days hard delete automatically no manual cleanup"). Run once a day
// by the scheduled call to app/api/cron/retention (vercel.json), and by
// scripts/run-retention.ts by hand. One run:
//   1. erases every deactivated account whose 30 days are up, checks the
//      erasure and emails the confirmation (lib/privacy/deletion.ts);
//   2. deletes retained records whose legal period has ended (lib/privacy/
//      retention.ts);
//   3. deletes rows older than their table's age limit (config/personal-data.ts
//      `ageLimitDays`): logs, error records, spent sign-in tokens.
// Every deletion is in the audit trail. deletionsOverdue() is the health
// signal: an account still not erased 72 hours after its due time means the job
// is not running, and /api/health says so.

import "server-only";

import { and, isNotNull, lt, lte, sql } from "drizzle-orm";
import { recordAuditEvent } from "@/lib/audit/trail";
import { users } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";
import { ERASURE_CONFIRM_HOURS, PERSONAL_DATA_MAP } from "@/config/personal-data";
import { columnOf, tableNamed } from "@/lib/privacy/tables";
import { eraseAccount, type ErasureResult, type TenantPlane } from "@/lib/privacy/deletion";
import { expireRetainedRecords } from "@/lib/privacy/retention";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Sends the "your data has been deleted" confirmation. Injected for tests. */
export type ConfirmErasure = (email: string, result: ErasureResult) => Promise<void>;

export interface RetentionRun {
  erased: ErasureResult[];
  expiredRetained: number;
  purged: Record<string, number>;
}

/** Delete rows older than each table's age limit. */
export async function purgeByAge(db: AppDatabase, now: Date): Promise<Record<string, number>> {
  const purged: Record<string, number> = {};
  for (const [name, entry] of Object.entries(PERSONAL_DATA_MAP)) {
    if (entry.plane !== "catalog" || !entry.ageLimitDays || !entry.ageColumn) continue;
    const table = tableNamed(name);
    const col = columnOf(table, entry.ageColumn);
    const cutoff = new Date(now.getTime() - entry.ageLimitDays * DAY_MS);
    const where = and(isNotNull(col), lt(col, cutoff));
    const n = await db.select({ n: sql<number>`count(*)` }).from(table).where(where).all();
    const count = Number(n[0]?.n ?? 0);
    if (count === 0) continue;
    await db.delete(table).where(where).run();
    purged[name] = count;
  }
  if (Object.keys(purged).length > 0) {
    await recordAuditEvent(
      {
        action: "data_deleted",
        actor: "system",
        target: "retention:age-limit",
        after: { purged, at: now.toISOString() },
      },
      db,
    );
  }
  return purged;
}

/** Accounts whose erasure is due now. */
async function dueAccounts(db: AppDatabase, now: Date): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(isNotNull(users.deactivatedAt), isNotNull(users.deletionDueAt), lte(users.deletionDueAt, now)))
    .all();
  return rows.map((r) => r.id);
}

/** One run of the retention job. */
export async function runRetentionJob(
  db: AppDatabase,
  opts: { now?: Date; tenantPlane?: TenantPlane; confirm?: ConfirmErasure } = {},
): Promise<RetentionRun> {
  const now = opts.now ?? new Date();
  const erased: ErasureResult[] = [];
  for (const id of await dueAccounts(db, now)) {
    const r = await eraseAccount(db, id, { now, tenantPlane: opts.tenantPlane });
    if (!r) continue;
    erased.push(r);
    if (r.verified && opts.confirm) {
      try {
        await opts.confirm(r.email, r);
      } catch (e) {
        console.error("retention: the erasure confirmation email failed", e instanceof Error ? e.message : e);
      }
    }
  }
  const expiredRetained = await expireRetainedRecords(db, now);
  const purged = await purgeByAge(db, now);
  return { erased, expiredRetained, purged };
}

/**
 * Accounts still not erased ERASURE_CONFIRM_HOURS (72) after their due time:
 * the job is not running or keeps failing. Read by the health check.
 */
export async function deletionsOverdue(db: AppDatabase, now: Date = new Date()): Promise<number> {
  const late = new Date(now.getTime() - ERASURE_CONFIRM_HOURS * HOUR_MS);
  const r = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(isNotNull(users.deactivatedAt), isNotNull(users.deletionDueAt), lt(users.deletionDueAt, late)))
    .all();
  return Number(r[0]?.n ?? 0);
}
