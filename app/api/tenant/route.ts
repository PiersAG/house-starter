// GET /api/tenant — the signed-in caller's own workspace record.
//
// The template's one APP-DATA route, and therefore the shortest complete
// demonstration of the ADR-023 seam: it reads `tenant_meta` from the caller's
// OWN database, reached through getTenantDb() with the tenant taken from the
// session. There is no tenant parameter, no `x-tenant-id` header and no
// `where tenant_id = ?` clause — another customer's row is not filtered out,
// it is not in the database being queried.
//
// A builder adding a domain model copies this shape: `await getTenantDb()`,
// then query. tests/isolation/per-tenant.spec.ts discovers this route by
// walking app/ and mounts the cross-tenant attack against it.
//
// PAYWALL (item 17). App data is behind the subscription gate, and this route
// returns app data — so it calls enforcePaidApi like every other data route.
// It previously did not, while an app's config/billing.ts listed "/api/tenant"
// in gatedRoutePrefixes: the gate was DECLARED and never enforced, because the
// prefix list is only ever consulted from inside enforcePaidApi (there is no
// middleware that reads it). Declaring a gate no handler calls is the failure
// mode this call closes. Inert in the template, where gatedRoutePrefixes is
// empty; live in an app that lists this path.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { catalogDb } from "@/lib/catalog";
import { enforcePaidApi } from "@/lib/billing/enforce";
import { getTenantDb } from "@/lib/tenant-context";
import { tenantMeta } from "@/lib/schema";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "You must be signed in." },
      { status: 401 },
    );
  }

  const denied = await enforcePaidApi(catalogDb, session.user.id, "/api/tenant");
  if (denied) return denied;

  const db = await getTenantDb();
  const rows = await db.select().from(tenantMeta).limit(1).all();
  const meta = rows[0];
  if (!meta) {
    return NextResponse.json(
      { error: "This workspace has not finished being set up." },
      { status: 503 },
    );
  }

  return NextResponse.json({
    tenant: { id: meta.tenantId, label: meta.label },
  });
}
