// Account deletion (app-business-core issues 722, 745, 352; Matt Murphy #156,
// #172, #203, #288).
//
//   * requestAccountDeletion — the "delete my account" button: the account is
//     DEACTIVATED at once (sign-in refused, every session ended) and its data
//     kept for DELETION_GRACE_DAYS (30) days.
//   * eraseAccount — on the due day the retention job (lib/privacy/retention-
//     job.ts) erases it, table by table, the way config/personal-data.ts says:
//     delete, anonymise, keep only what the law requires (lib/privacy/
//     retention.ts), or wipe the account's own database. It then CHECKS that
//     nothing remains, writes the erasure ledger (replayed after a backup
//     restore), records the whole result in the audit trail, and emails the
//     confirmation — within ERASURE_CONFIRM_HOURS (72) of the due time, which
//     the health check holds (deletionsOverdue).
//
// Every step goes to the audit trail through lib/audit/trail.ts's existing
// recordAuditEvent (action data_deleted), which this module does not change.

import "server-only";

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { recordAuditEvent } from "@/lib/audit/trail";
import { billingInvoices, erasures, subscriptions, users, type User } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";
import {
  DELETION_GRACE_DAYS,
  PERSONAL_DATA_MAP,
  type DataMapEntry,
} from "@/config/personal-data";
import { columnOf, tableNamed } from "@/lib/privacy/tables";
import { ownTenant, subjectWhere, type Subject } from "@/lib/privacy/subject";
import { retainForErasure, type RetainedSummary } from "@/lib/privacy/retention";
import { sqlIdent } from "@/lib/sql-ident";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Subscription states that are still billing: the owner cancels first. */
const LIVE_SUBSCRIPTION = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

export type DeletionErrorCode = "not_found" | "subscription_active";

export class DeletionError extends Error {
  constructor(
    public readonly code: DeletionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeletionError";
  }
}

export { isDeactivated } from "@/lib/privacy/deactivation";

/** Read one account's deactivation state (null = no such account). */
export async function deactivationOf(
  db: AppDatabase,
  userId: string,
): Promise<{ deactivatedAt: Date | null; deletionDueAt: Date | null } | null> {
  const rows = await db
    .select({ deactivatedAt: users.deactivatedAt, deletionDueAt: users.deletionDueAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

/**
 * Deactivate the account now and schedule its erasure. Idempotent: a second
 * request returns the date already set. Refused while a paid subscription is
 * still running — cancelling it is a payment action the owner takes on the
 * billing page (the money path is not changed here).
 */
export async function requestAccountDeletion(
  db: AppDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<{ deletionDueAt: Date; email: string; alreadyRequested: boolean }> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1).all();
  const user = rows[0];
  if (!user) throw new DeletionError("not_found", "This account no longer exists.");
  if (user.deactivatedAt && user.deletionDueAt) {
    return { deletionDueAt: user.deletionDueAt, email: user.email, alreadyRequested: true };
  }
  const subs = await db
    .select({ status: subscriptions.status, stripeSubscriptionId: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .all();
  if (subs.some((s) => s.stripeSubscriptionId && LIVE_SUBSCRIPTION.has(s.status))) {
    throw new DeletionError(
      "subscription_active",
      "Your subscription is still running. Cancel it on the billing page first, then delete your account.",
    );
  }
  const deletionDueAt = new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS);
  await db
    .update(users)
    // sessionsValidFrom ends every other session at its next renewal
    // (lib/revoked-sessions.ts); the sign-in check refuses a deactivated account.
    .set({ deactivatedAt: now, deletionDueAt, sessionsValidFrom: now })
    .where(eq(users.id, userId))
    .run();
  await recordAuditEvent(
    {
      action: "data_deleted",
      actor: userId,
      subjectUserId: userId,
      tenantId: user.tenantId,
      target: "account:deactivated",
      before: { deactivatedAt: null },
      after: { deactivatedAt: now.toISOString(), deletionDueAt: deletionDueAt.toISOString() },
    },
    db,
  );
  return { deletionDueAt, email: user.email, alreadyRequested: false };
}

/** The ids that name this account in every table. */
export async function subjectOf(db: AppDatabase, user: Pick<User, "id" | "tenantId">): Promise<Subject> {
  const ids = new Set<string>();
  for (const r of await db
    .select({ id: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, user.id), isNotNull(subscriptions.stripeCustomerId)))
    .all()) {
    if (r.id) ids.add(r.id);
  }
  for (const r of await db
    .select({ id: billingInvoices.stripeCustomerId })
    .from(billingInvoices)
    .where(eq(billingInvoices.userId, user.id))
    .all()) {
    if (r.id) ids.add(r.id);
  }
  return { userId: user.id, tenantId: user.tenantId ?? null, stripeCustomerIds: [...ids] };
}

/** How the account's own database is reached and removed. Injected for tests. */
export interface TenantPlane {
  /** Open the account's own database. */
  open(tenantId: string): Promise<AppDatabase>;
  /** Remove the database at its platform, if the adapter can. False = only wiped. */
  destroy?(tenantId: string): Promise<boolean>;
  /** Whether the database is still at its platform (read-only). Throws when unsure. */
  exists?(tenantId: string): Promise<boolean>;
}

/** Delete every row of every table in a tenant database. Returns the tables wiped. */
export async function wipeTenantDatabase(tenant: AppDatabase): Promise<string[]> {
  const res = await tenant.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const names = res.map((r) => r.name);
  for (const name of names) {
    await tenant.run(sql.raw(`DELETE FROM ${sqlIdent(name)}`));
  }
  return names;
}

export interface ErasureResult {
  userId: string;
  deleted: Record<string, number>;
  anonymised: Record<string, number>;
  retained: RetainedSummary[];
  tenantDatabase: "removed" | "wiped" | "none";
  /**
   * Why the account's tenant was left as it is, when it was: another account
   * still links it, or the account is a sign-up that never finished (its
   * database, if one was made, is found through its tenant_orphans record and
   * removed by the sign-up's rollback or the factory's sweep). Null when the
   * tenant was erased or there was none.
   */
  tenantKept: "linked-by-another-account" | "unfinished-sign-up" | null;
  /** Tables still holding this account's rows after erasure; empty = verified. */
  remaining: string[];
  verified: boolean;
  email: string;
}

/** Order: child tables first, then tenants, then users (foreign keys). */
function erasureOrder(): [string, DataMapEntry][] {
  const last = ["tenants", "users"];
  const entries = Object.entries(PERSONAL_DATA_MAP);
  return [
    ...entries.filter(([n]) => !last.includes(n)),
    ...last.map((n) => [n, PERSONAL_DATA_MAP[n]] as [string, DataMapEntry]),
  ];
}

async function countRows(db: AppDatabase, name: string, entry: DataMapEntry, subject: Subject): Promise<number> {
  const table = tableNamed(name);
  const where = subjectWhere(entry, table, subject);
  if (!where) return 0;
  const r = await db.select({ n: sql<number>`count(*)` }).from(table).where(where).all();
  return Number(r[0]?.n ?? 0);
}

/**
 * The tables that still hold this account's rows — every table whose map entry
 * deletes, retains or anonymises them. Empty means the erasure is complete.
 */
export async function remainingLocations(db: AppDatabase, subject: Subject): Promise<string[]> {
  const left: string[] = [];
  for (const [name, entry] of Object.entries(PERSONAL_DATA_MAP)) {
    if (entry.plane !== "catalog") continue;
    const rule = entry.onErasure.rule;
    if (rule !== "delete" && rule !== "retain" && rule !== "anonymise") continue;
    if ((await countRows(db, name, entry, subject)) > 0) left.push(name);
  }
  return left;
}

/**
 * Whether erasing this account may erase its tenant — the tenant's database and
 * every catalog row keyed by the tenant id (its registration, its credential
 * events). Only when the tenant is the account's own, not the shared one, AND:
 *
 *   * the account is not a sign-up that never finished. Such an account is
 *     erased as an account only, whatever it links: a database its sign-up made
 *     was recorded in tenant_orphans before it was asked for
 *     (lib/tenant/signup-provisioning.ts), and that record — not the account or
 *     its link — is how the rollback and the factory's sweep find and remove it;
 *   * no other account links it — erasing one account never erases a
 *     workspace another account still uses.
 *
 * Read immediately before the tenant is touched.
 */
export async function tenantErasable(
  db: AppDatabase,
  user: Pick<User, "id" | "tenantId" | "signupPendingSince">,
): Promise<{ tenantId: string | null; kept: ErasureResult["tenantKept"] }> {
  const tenantId = user.tenantId ?? null;
  if (!ownTenant(tenantId)) return { tenantId: null, kept: null };
  if (user.signupPendingSince !== null) return { tenantId: null, kept: "unfinished-sign-up" };
  const others = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), ne(users.id, user.id)))
    .limit(1)
    .all();
  if (others.length > 0) return { tenantId: null, kept: "linked-by-another-account" };
  return { tenantId, kept: null };
}

/**
 * Erase one account now. The caller (the retention job, or the replay after a
 * restore) decides that it is due. Never deletes the shared tenant database,
 * nor a tenant {@link tenantErasable} keeps.
 */
export async function eraseAccount(
  db: AppDatabase,
  userId: string,
  opts: { now?: Date; tenantPlane?: TenantPlane; actor?: string } = {},
): Promise<ErasureResult | null> {
  const now = opts.now ?? new Date();
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1).all();
  const user = rows[0];
  if (!user) return null;
  const linked = await subjectOf(db, user);
  // A tenant this erasure may not touch is taken out of the subject, so neither
  // its database nor any catalog row keyed by its id is erased with the account.
  const erasable = await tenantErasable(db, user);
  if (erasable.kept) {
    console.error(`privacy: erasing account ${userId} without its tenant (${erasable.kept})`);
  }
  const subject: Subject = { ...linked, tenantId: erasable.tenantId };

  // The account's own database first: opening it reads its catalog row, which
  // the table loop below deletes.
  let tenantDatabase: ErasureResult["tenantDatabase"] = "none";
  if (ownTenant(subject.tenantId) && opts.tenantPlane) {
    await wipeTenantDatabase(await opts.tenantPlane.open(subject.tenantId));
    tenantDatabase = "wiped";
    if (opts.tenantPlane.destroy && (await opts.tenantPlane.destroy(subject.tenantId))) {
      tenantDatabase = "removed";
    }
  }

  const retained = await retainForErasure(db, subject, now);
  const deleted: Record<string, number> = {};
  const anonymised: Record<string, number> = {};
  for (const [name, entry] of erasureOrder()) {
    if (entry.plane !== "catalog") continue;
    const rule = entry.onErasure;
    if (rule.rule !== "delete" && rule.rule !== "retain" && rule.rule !== "anonymise") continue;
    const table = tableNamed(name);
    const where = subjectWhere(entry, table, subject);
    if (!where) continue;
    const n = await countRows(db, name, entry, subject);
    if (n === 0) continue;
    if (rule.rule === "anonymise") {
      const cleared: Record<string, null> = {};
      for (const c of rule.columns) {
        columnOf(table, c);
        cleared[c] = null;
      }
      await db.update(table).set(cleared).where(where).run();
      anonymised[name] = n;
    } else {
      await db.delete(table).where(where).run();
      deleted[name] = n;
    }
  }

  const remaining = await remainingLocations(db, subject);
  const verified = remaining.length === 0;
  await db
    .insert(erasures)
    .values({
      userId,
      tenantId: linked.tenantId,
      requestedAt: user.deactivatedAt ?? now,
      erasedAt: now,
    })
    .onConflictDoUpdate({ target: erasures.userId, set: { erasedAt: now } })
    .run();
  await recordAuditEvent(
    {
      action: "data_deleted",
      actor: opts.actor ?? "system",
      subjectUserId: userId,
      tenantId: linked.tenantId,
      target: "account",
      before: {
        deactivatedAt: user.deactivatedAt?.toISOString() ?? null,
        deletionDueAt: user.deletionDueAt?.toISOString() ?? null,
      },
      after: {
        verified,
        remaining,
        deleted,
        anonymised,
        retained,
        tenantDatabase,
        tenantKept: erasable.kept,
        erasedAt: now.toISOString(),
      },
    },
    db,
  );
  return {
    userId,
    deleted,
    anonymised,
    retained,
    tenantDatabase,
    tenantKept: erasable.kept,
    remaining,
    verified,
    email: user.email,
  };
}

/** One row of the erasure ledger, as exported before a backup restore. */
export interface LedgerEntry {
  userId: string;
  tenantId: string | null;
}

/** The erasure ledger: every erased account's ids. */
export async function erasureLedger(db: AppDatabase): Promise<LedgerEntry[]> {
  return db.select({ userId: erasures.userId, tenantId: erasures.tenantId }).from(erasures).all();
}

/**
 * After a database is restored from a backup taken before some erasures, erase
 * every ledger account the restore brought back, and put the ledger rows back.
 * Returns the ids erased again.
 */
export async function replayErasures(
  db: AppDatabase,
  ledger: LedgerEntry[],
  opts: { now?: Date; tenantPlane?: TenantPlane } = {},
): Promise<string[]> {
  const again: string[] = [];
  for (const e of ledger) {
    const r = await eraseAccount(db, e.userId, { ...opts, actor: "operator" });
    if (r) again.push(e.userId);
    else {
      const now = opts.now ?? new Date();
      await db
        .insert(erasures)
        .values({ userId: e.userId, tenantId: e.tenantId, requestedAt: now, erasedAt: now })
        .onConflictDoNothing()
        .run();
    }
  }
  return again;
}
