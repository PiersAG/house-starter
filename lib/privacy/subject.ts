// Which rows of a table belong to one account, read from the table's entry in
// the personal-data map (config/personal-data.ts). One rule for the data
// report, the deletion pipeline, the retention layer and the erasure check, so
// "everything we hold on you" and "everything we delete" are the same rows.

import "server-only";

import { eq, inArray, type SQL } from "drizzle-orm";
import { and, isNotNull } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DataMapEntry } from "@/config/personal-data";
import { columnOf } from "@/lib/privacy/tables";

/**
 * The shared tenant's id (lib/tenant-context.ts SHARED_TENANT_ID), repeated here
 * so the deletion pipeline and its scripts do not load the sign-in library;
 * tests/unit/account-deletion.test.ts holds the two equal.
 */
export const SHARED_TENANT = "__shared__";

/** The ids that name one account across the app's tables. */
export interface Subject {
  userId: string;
  /** The account's own database id; null in shared mode or before provisioning. */
  tenantId: string | null;
  /** The account's Stripe customer ids (from its subscription and invoices). */
  stripeCustomerIds: string[];
}

/** True when `tenantId` is the account's own database, not the shared one. */
export function ownTenant(tenantId: string | null | undefined): tenantId is string {
  return typeof tenantId === "string" && tenantId.length > 0 && tenantId !== SHARED_TENANT;
}

/** The values `entry.linkedBy` must hold for a row to be this account's. */
export function linkValues(entry: DataMapEntry, subject: Subject): string[] {
  switch (entry.linkKind ?? "userId") {
    case "userId":
      return [subject.userId];
    case "tenantId":
      return ownTenant(subject.tenantId) ? [subject.tenantId] : [];
    case "stripeCustomerId":
      return subject.stripeCustomerIds;
  }
}

/**
 * The WHERE clause selecting this account's rows, or undefined when the table
 * holds none of them (no link column, or no id of the right kind).
 */
export function subjectWhere(
  entry: DataMapEntry,
  table: SQLiteTable,
  subject: Subject,
): SQL | undefined {
  if (!entry.linkedBy) return undefined;
  const values = linkValues(entry, subject);
  if (values.length === 0) return undefined;
  const col = columnOf(table, entry.linkedBy);
  return values.length === 1
    ? and(isNotNull(col), eq(col, values[0]))
    : and(isNotNull(col), inArray(col, values));
}
