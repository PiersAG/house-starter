// Tenant data access log and runtime cross-tenant detection
// (PiersAG/app-business-core#806; Matt Murphy #171: "how long is this happening
// for who else could have seen my data" and "build monitoring that alerts the
// moment a tenant sees another tenant's data").
//
// The isolation tests (tests/isolation/) stop a leak before release; this
// catches one in production. Every time a request opens a tenant's database
// (lib/db.ts getDb) one row goes into the catalog's `tenant_access_events`:
// whose data, which signed-in user from which tenant, the request id, the
// route, when. Once per request per tenant.
//
// DETECTION. A signed-in caller from tenant A opening tenant B's database is a
// cross-tenant access: the row is marked cross_tenant = 1 and, the same moment,
//   * an error-level `cross_tenant_access` line goes to the structured log and
//     its sink,
//   * with error tracking on (config/error-tracking.ts), a distinct Sentry
//     event goes out: level fatal, tag alert=cross_tenant_access, one group of
//     its own, never sampled away — naming the account and the two customers'
//     opaque ids, never their data (lib/observability/sentry.ts),
//   * a row goes into the durable error log, and
//   * /api/health's `tenant_isolation` check fails (503) while any such access
//     happened in the last 24 hours, so the external prober raises the alert.
// It is detected, not blocked here: the request already holds the handle, and
// the tests are the prevention.
//
// THE QUESTIONS IT ANSWERS (tenantAccessReport): from when to when the data was
// opened by someone outside the tenant ("how long"), and every user and tenant
// that opened it in a window ("who else could have seen my data").
//
// Not recorded: shared tenancy (one database for everyone — there is no
// per-tenant database to open), and code running outside a request (scripts,
// migrations), which is the operator's own access.
//
// NEVER THROWS into the request: a failed write is reported on stderr.

import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { getCatalogDb } from "@/lib/catalog";
import { recordError } from "@/lib/observability/error-log";
import { logEvent } from "@/lib/observability/log";
import { reportCrossTenantAccess } from "@/lib/observability/sentry";
import { currentRequest, noteRequestUser } from "@/lib/observability/request-context";
import { tenantAccessEvents } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";

/** Who the session says the caller is, read lazily when the request has not said yet. */
async function sessionCaller(): Promise<{ userId: string | null; tenantId: string | null }> {
  const ctx = currentRequest();
  if (ctx?.tenantId) return { userId: ctx.userId, tenantId: ctx.tenantId };
  try {
    const { auth } = await import("@/lib/auth");
    const session = await auth();
    const userId = session?.user?.id ?? null;
    const tenantId = session?.user?.tenantId ?? null;
    noteRequestUser(userId, tenantId);
    return { userId, tenantId };
  } catch {
    return { userId: ctx?.userId ?? null, tenantId: null };
  }
}

/**
 * Record that this request opened `dataTenantId`'s database, and raise the
 * alert when the caller belongs to another tenant. Called by lib/db.ts getDb.
 */
export async function noteTenantAccess(
  dataTenantId: string,
  opts: { db?: AppDatabase; caller?: { userId: string | null; tenantId: string | null } } = {},
): Promise<void> {
  const ctx = currentRequest();
  if (!ctx || ctx.tenantsOpened.has(dataTenantId)) return;
  ctx.tenantsOpened.add(dataTenantId);
  try {
    const caller = opts.caller ?? (await sessionCaller());
    const cross = caller.tenantId !== null && caller.tenantId !== dataTenantId;
    await (opts.db ?? getCatalogDb())
      .insert(tenantAccessEvents)
      .values({
        id: `access-${randomUUID()}`,
        tenantId: dataTenantId,
        sessionTenantId: caller.tenantId,
        userId: caller.userId,
        requestId: ctx.requestId,
        route: ctx.route,
        crossTenant: cross ? 1 : 0,
      })
      .run();
    if (cross) {
      reportCrossTenantAccess({
        userId: caller.userId,
        sessionTenantId: caller.tenantId,
        dataTenantId,
        route: ctx.route,
        method: ctx.method,
        requestId: ctx.requestId,
      });
      logEvent({
        level: "error",
        event: "cross_tenant_access",
        userId: caller.userId,
        tenantId: caller.tenantId,
        fields: { data_tenant_id: dataTenantId },
      });
      await recordError({
        message: `cross-tenant access: a session of tenant ${caller.tenantId} opened tenant ${dataTenantId}'s database`,
        route: ctx.route,
        method: ctx.method,
        requestId: ctx.requestId,
        level: "error",
        context: { kind: "cross_tenant_access", data_tenant_id: dataTenantId },
      });
    }
  } catch (e) {
    console.error(
      `tenant access log: could not record an access to tenant ${dataTenantId}`,
      e instanceof Error ? e.message : e,
    );
  }
}

/** Cross-tenant accesses since `sinceEpochMs` (for /api/health). May throw. */
export async function crossTenantCountSince(
  sinceEpochMs: number,
  db: AppDatabase = getCatalogDb(),
): Promise<number> {
  const rows = await db
    .select({ id: tenantAccessEvents.id })
    .from(tenantAccessEvents)
    .where(
      and(
        eq(tenantAccessEvents.crossTenant, 1),
        gte(tenantAccessEvents.occurredAt, new Date(sinceEpochMs)),
      ),
    )
    .all();
  return rows.length;
}

export interface TenantAccessor {
  userId: string | null;
  sessionTenantId: string | null;
  crossTenant: boolean;
  requests: number;
  first: Date;
  last: Date;
}

export interface TenantAccessReport {
  tenantId: string;
  /** Every user (and the tenant they signed in under) that opened this tenant's data. */
  accessors: TenantAccessor[];
  /** "How long": the first and last access by a caller from another tenant, or null. */
  exposure: { first: Date; last: Date; requests: number } | null;
}

/** Who opened `tenantId`'s data in [since, until], and the cross-tenant window. */
export async function tenantAccessReport(
  tenantId: string,
  opts: { since?: Date; until?: Date; db?: AppDatabase } = {},
): Promise<TenantAccessReport> {
  const db = opts.db ?? getCatalogDb();
  const conds = [eq(tenantAccessEvents.tenantId, tenantId)];
  if (opts.since) conds.push(gte(tenantAccessEvents.occurredAt, opts.since));
  if (opts.until) conds.push(lte(tenantAccessEvents.occurredAt, opts.until));
  const rows = await db
    .select()
    .from(tenantAccessEvents)
    .where(and(...conds))
    .orderBy(asc(tenantAccessEvents.occurredAt))
    .all();
  const byCaller = new Map<string, TenantAccessor>();
  let exposure: TenantAccessReport["exposure"] = null;
  for (const r of rows) {
    const key = `${r.userId ?? ""}|${r.sessionTenantId ?? ""}`;
    const a = byCaller.get(key);
    if (a) {
      a.requests += 1;
      a.last = r.occurredAt;
    } else {
      byCaller.set(key, {
        userId: r.userId,
        sessionTenantId: r.sessionTenantId,
        crossTenant: r.crossTenant === 1,
        requests: 1,
        first: r.occurredAt,
        last: r.occurredAt,
      });
    }
    if (r.crossTenant === 1) {
      exposure = exposure
        ? { first: exposure.first, last: r.occurredAt, requests: exposure.requests + 1 }
        : { first: r.occurredAt, last: r.occurredAt, requests: 1 };
    }
  }
  return { tenantId, accessors: [...byCaller.values()], exposure };
}
