// The retention layer (app-business-core issue 791; Matt Murphy #137: "a system
// that knows the difference between the data a user controls and the data the
// law requires you to keep"; "compliance data stays locked in a separate
// retention layer with an expiration date attached to it"; "show exactly what
// was retained what was anonymized and when the clock started and also when it
// expires").
//
// When an account is erased, a table whose personal-data map entry says
// `retain` (config/personal-data.ts) has only the fields the law needs copied
// into `retained_records`, each with its legal reason, the day the clock
// started and the day it expires. The source rows are then deleted with the
// rest of the account. The retention job deletes each retained record on its
// expiry day. Every step is written to the audit trail (lib/audit/trail.ts,
// through its existing recordAuditEvent) so the business can show a regulator
// that it followed the policy.

import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { recordAuditEvent } from "@/lib/audit/trail";
import { retainedRecords, type RetainedRecord } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";
import { PERSONAL_DATA_MAP, type ErasureRule } from "@/config/personal-data";
import { tableNamed } from "@/lib/privacy/tables";
import { subjectWhere, type Subject } from "@/lib/privacy/subject";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `years` after `from`, as a date. */
export function addYears(from: Date, years: number): Date {
  const d = new Date(from.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

/** What one account's erasure kept, by table. */
export interface RetainedSummary {
  table: string;
  count: number;
  legalBasis: string;
  expiresAt: string;
}

type RetainRule = Extract<ErasureRule, { rule: "retain" }>;

/**
 * Copy the fields the law needs from every `retain` table's rows for this
 * account into the retention layer. Called by the deletion pipeline BEFORE it
 * deletes the rows. Returns what was kept, per table.
 */
export async function retainForErasure(
  db: AppDatabase,
  subject: Subject,
  now: Date,
): Promise<RetainedSummary[]> {
  const out: RetainedSummary[] = [];
  for (const [name, entry] of Object.entries(PERSONAL_DATA_MAP)) {
    if (entry.onErasure.rule !== "retain" || !entry.linkedBy) continue;
    const rule = entry.onErasure as RetainRule;
    const table = tableNamed(name);
    const where = subjectWhere(entry, table, subject);
    if (!where) continue;
    const rows = (await db.select().from(table).where(where).all()) as Record<string, unknown>[];
    if (rows.length === 0) continue;
    const expiresAt = addYears(now, rule.years);
    const keyColumn = rule.keep[0];
    for (const row of rows) {
      const kept: Record<string, unknown> = {};
      for (const k of rule.keep) kept[k] = row[k] instanceof Date ? (row[k] as Date).toISOString() : row[k];
      await db
        .insert(retainedRecords)
        .values({
          id: `ret-${randomUUID()}`,
          sourceTable: name,
          recordKey: String(row[keyColumn] ?? ""),
          subjectUserId: subject.userId,
          data: JSON.stringify(kept),
          legalBasis: rule.legalBasis,
          clockStartedAt: now,
          expiresAt,
        })
        .run();
    }
    out.push({
      table: name,
      count: rows.length,
      legalBasis: rule.legalBasis,
      expiresAt: expiresAt.toISOString(),
    });
  }
  return out;
}

/**
 * Delete every retained record whose expiry has passed, and record each
 * deletion in the audit trail. Returns how many were deleted.
 */
export async function expireRetainedRecords(db: AppDatabase, now: Date): Promise<number> {
  const due = await db
    .select()
    .from(retainedRecords)
    .where(lte(retainedRecords.expiresAt, now))
    .all();
  for (const r of due) {
    await db
      .delete(retainedRecords)
      .where(and(eq(retainedRecords.id, r.id), lte(retainedRecords.expiresAt, now)))
      .run();
    await recordAuditEvent(
      {
        action: "data_deleted",
        actor: "system",
        subjectUserId: r.subjectUserId,
        target: `retained:${r.sourceTable}`,
        before: { recordKey: r.recordKey, clockStartedAt: r.clockStartedAt, expiresAt: r.expiresAt },
        after: { deleted: true, reason: "retention period ended" },
      },
      db,
    );
  }
  return due.length;
}

/** One account's retained records, as an operator shows them to a regulator. */
export interface RetentionReportRow {
  table: string;
  recordKey: string;
  legalBasis: string;
  clockStartedAt: string;
  expiresAt: string;
  daysLeft: number;
}

/** What is still kept for an erased account, and when each record expires. */
export async function retentionReport(
  db: AppDatabase,
  subjectUserId: string,
  now: Date = new Date(),
): Promise<RetentionReportRow[]> {
  const rows: RetainedRecord[] = await db
    .select()
    .from(retainedRecords)
    .where(eq(retainedRecords.subjectUserId, subjectUserId))
    .all();
  return rows.map((r) => ({
    table: r.sourceTable,
    recordKey: r.recordKey,
    legalBasis: r.legalBasis,
    clockStartedAt: r.clockStartedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    daysLeft: Math.max(0, Math.ceil((r.expiresAt.getTime() - now.getTime()) / DAY_MS)),
  }));
}
