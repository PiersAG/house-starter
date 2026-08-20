// Per-request tenant context — the one place app code asks "whose data am I
// allowed to touch?" (ADR-023 per_tenant).
//
// The tenant is a SERVER-SIDE FACT taken from the authenticated session. It is
// never read from a header, a query string, a path segment or a body, because a
// tenant the caller can name is a tenant the caller can change: that is exactly
// the attack tests/isolation/per-tenant.spec.ts mounts with `x-tenant-id`.
//
// Usage in a page, action or route handler:
//
//   const db = await getTenantDb();          // this caller's data database
//   const rows = await db.select().from(dogs).all();
//
// There is no tenant filter to remember and no `where tenantId = …` to forget:
// the handle is a connection to that customer's own database, so another
// customer's rows are not merely filtered out, they are not present.
//
// In TENANCY_MODE=shared the same call returns the single shared database, so
// code written against this module runs unchanged in either mode.

import { auth } from "@/lib/auth";
import { getDb, getTenancyMode } from "@/lib/db";
import type { AppDatabase } from "@/lib/users";

/**
 * The tenant id used in shared mode, where every account lives in one database.
 * Matches lib/db.ts's TENANT_ID_PATTERN so the same call path validates.
 */
export const SHARED_TENANT_ID = "__shared__";

/** The signed-in caller's tenant, or null when there is no session. */
export async function currentTenantId(): Promise<string | null> {
  if (getTenancyMode() === "shared") return SHARED_TENANT_ID;
  const session = await auth();
  return session?.user?.tenantId ?? null;
}

/**
 * The signed-in caller's tenant, or a thrown error.
 *
 * Fail-closed by construction: an anonymous request, or a session minted before
 * the tenant claim existed, gets no database rather than a default one.
 */
export async function requireTenantId(): Promise<string> {
  const tenantId = await currentTenantId();
  if (!tenantId) {
    throw new Error(
      "lib/tenant-context.ts: no tenant on this request. App data is only " +
        "reachable through an authenticated session carrying a tenant — there is " +
        "no anonymous or default tenant. If this is a page every visitor should " +
        "see, it must not read tenant data.",
    );
  }
  return tenantId;
}

/** The database handle for this request's tenant. */
export async function getTenantDb(): Promise<AppDatabase> {
  return getDb(await requireTenantId());
}
