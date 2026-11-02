// Audit trail of sensitive customer actions (PiersAG/app-business-core#796;
// Matt Murphy #126: "no audit trail on sensitive actions users upgrading plans
// changing e-mail addresses deleting data modifying permissions none of it is
// logged").
//
// One append-only row per sensitive action in the catalog's `audit_events`
// (lib/migrate.ts adds triggers that refuse every UPDATE and DELETE, so a row
// cannot be changed or removed through the database either):
//   * plan_changed        — a subscription's plan or status moved (lib/billing)
//   * email_changed       — an account's sign-in email changed (lib/account/email.ts)
//   * data_deleted        — customer data deleted (settings values, records)
//   * permissions_changed — a role or an access grant changed (lib/account/roles.ts,
//                           lib/billing/grants.ts)
// Each row says who did it, whose account, what it changed from and to, when,
// and the request id. It is the evidence for a billing dispute (#370) or an
// accidental deletion.
//
// The same event also goes to the structured log (lib/observability/log.ts) as
// `audit.<action>` with ids only — never the before/after values, which can
// hold an email address.
//
// NEVER THROWS. A failed audit write is reported on stderr; the action itself
// has already happened and must not be turned into an error afterwards.

import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { getCatalogDb } from "@/lib/catalog";
import { logEvent } from "@/lib/observability/log";
import { currentRequest } from "@/lib/observability/request-context";
import { auditEvents, AUDIT_ACTIONS, type AuditAction, type AuditEvent } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";

export { AUDIT_ACTIONS, type AuditAction };

export interface AuditInput {
  action: AuditAction;
  /** A user id, "system" (webhook, job) or "operator" (a CLI). */
  actor: string;
  subjectUserId?: string | null;
  tenantId?: string | null;
  /** What changed, e.g. "subscription", "email", "setting:theme", "grant". */
  target: string;
  before?: unknown;
  after?: unknown;
}

function asText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 2000);
}

/** Append one audit row (the catalog by default). Never throws. */
export async function recordAuditEvent(
  input: AuditInput,
  db?: AppDatabase,
): Promise<boolean> {
  const requestId = currentRequest()?.requestId ?? null;
  logEvent({
    level: "info",
    event: `audit.${input.action}`,
    action: input.target,
    userId: input.subjectUserId ?? null,
    tenantId: input.tenantId ?? null,
    fields: { actor: input.actor },
  });
  try {
    await (db ?? getCatalogDb())
      .insert(auditEvents)
      .values({
        id: `audit-${randomUUID()}`,
        action: input.action,
        actor: input.actor,
        subjectUserId: input.subjectUserId ?? null,
        tenantId: input.tenantId ?? null,
        target: input.target,
        before: asText(input.before),
        after: asText(input.after),
        requestId,
      })
      .run();
    return true;
  } catch (e) {
    console.error(
      `audit: could not record ${input.action} on ${input.target}`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/** One account's audit history, newest first (an operator's dispute evidence). */
export async function auditHistory(
  subjectUserId: string,
  opts: { since?: Date; db?: AppDatabase } = {},
): Promise<AuditEvent[]> {
  const db = opts.db ?? getCatalogDb();
  const where = opts.since
    ? and(eq(auditEvents.subjectUserId, subjectUserId), gte(auditEvents.occurredAt, opts.since))
    : eq(auditEvents.subjectUserId, subjectUserId);
  return db.select().from(auditEvents).where(where).orderBy(desc(auditEvents.occurredAt)).all();
}
