// Live Drizzle ORM client for the house-starter template — the ADR-023 tenancy
// resolver seam, running fail-closed per stage0-tenant-isolation.
//
// Per-tenant is the factory default. Every APP-DATA access goes through
// getDb(tenantId), and the tenant comes from the session (lib/tenant-context.ts),
// never from the caller. Control-plane access — accounts, sessions, billing,
// settings — goes to the catalog instead (lib/catalog.ts); this module never
// serves it.
//
// HOW A TENANT IS RESOLVED
// ------------------------
// The CATALOG is the single routing authority. getDb(tenantId) reads that
// tenant's row from `tenants` and connects to the `db_url` it finds there. There
// is no environment-variable route to a tenant database and no DATABASE_URL
// fallback: an unregistered tenant throws, naming itself, rather than being
// served one customer's data from another customer's database.
//
// `db_url` is treated as OPAQUE. `file:/workspace/.build/isolation/tenant_a.db`
// and `libsql://k9coach-t_ab12-piersag.turso.io` take byte-identical code paths
// through createClient — the @libsql/client driver makes no distinction. That is
// the property the isolation harness relies on: two local files exercise exactly
// the routing that two Turso databases do in production, at zero cost.
//
// Resolution:
//   TENANCY_MODE unset OR "per_tenant":
//     catalog `tenants` row for <tenantId>  (required — throws if absent)
//   TENANCY_MODE = "shared":
//     DATABASE_URL                          (single shared DB for every tenant)
//
// tenantId is validated before use — only [A-Za-z0-9_]{1,64} is accepted, so
// path-traversal-shaped IDs ("../", null bytes) and punctuation variants that
// would collide after sanitisation (foo-bar vs foo_bar) are rejected rather
// than silently normalised into another tenant's slot.
//
// Migrations are NOT run here. Schema is applied out-of-band — by
// `npm run db:migrate` for the catalog, and by the provisioner
// (lib/tenant/provisioner.ts) the moment a tenant database is created.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/lib/users";
import { getCatalogDb } from "@/lib/catalog";
import { tenants } from "@/lib/schema";

export type TenancyMode = "per_tenant" | "shared";

export function getTenancyMode(): TenancyMode {
  const raw = (process.env.TENANCY_MODE ?? "per_tenant").trim().toLowerCase();
  if (raw !== "per_tenant" && raw !== "shared") {
    throw new Error(
      `lib/db.ts: TENANCY_MODE must be "per_tenant" or "shared" (got ${JSON.stringify(raw)}). ` +
        `Default is per_tenant (ADR-023).`,
    );
  }
  return raw;
}

const TENANT_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export function assertValidTenantId(tenantId: string): void {
  if (typeof tenantId !== "string" || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(
      `lib/db.ts: invalid tenantId ${JSON.stringify(tenantId)} — must match ` +
        `${TENANT_ID_PATTERN.source}. Path-traversal-shaped IDs, punctuation, and ` +
        `characters outside [A-Za-z0-9_] are rejected, not silently normalised into ` +
        `another tenant's slot (stage0-tenant-isolation).`,
    );
  }
}

function normaliseUrl(raw: string | undefined): string {
  // Tests may pass ":memory:" explicitly; the running app never defaults to
  // in-memory. Any bare filename becomes file:<name>.
  /* v8 ignore start -- defensive guard: every caller already throws on an
     empty/unset URL before reaching this, and the catalog column is NOT NULL.
     Kept for future callers; excluded from the per-file coverage gate. */
  if (!raw || raw.length === 0) {
    throw new Error("lib/db.ts: empty database URL");
  }
  /* v8 ignore stop */
  if (raw === ":memory:") return raw;
  if (/^[a-z]+:/i.test(raw)) return raw;
  return `file:${raw}`;
}

export interface TenantConnection {
  url: string;
  authToken?: string;
}

/**
 * Where does this tenant's data live? The catalog answers; nothing else does.
 *
 * Async because the answer is a row in a database, not an environment variable —
 * which is the whole point of a routing seam: tenants are created at runtime by
 * sign-up, and a process that had to be restarted to learn about a new customer
 * would not be a SaaS.
 */
export async function resolveTenant(tenantId: string): Promise<TenantConnection> {
  assertValidTenantId(tenantId);
  const mode = getTenancyMode();

  if (mode === "shared") {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "lib/db.ts: TENANCY_MODE=shared but DATABASE_URL is not set. " +
          "Set DATABASE_URL, or unset TENANCY_MODE to fall back to per-tenant (default).",
      );
    }
    return {
      url: normaliseUrl(url),
      authToken: process.env.DATABASE_AUTH_TOKEN,
    };
  }

  // per_tenant (default) — fail-closed. The catalog is the only route, and
  // DATABASE_URL is never consulted for tenant data.
  const rows = await getCatalogDb()
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) {
    throw new Error(
      `lib/db.ts: tenant ${JSON.stringify(tenantId)} is not registered in the catalog ` +
        `(no row in \`tenants\`), so it has no database. Per-tenant mode requires an ` +
        `explicit database per tenant (ADR-023); DATABASE_URL is NOT consulted as a ` +
        `fallback. Tenants are registered by the provisioner at sign-up — see ` +
        `lib/tenant/provisioner.ts. Set TENANCY_MODE=shared to opt into shared tenancy.`,
    );
  }
  return {
    url: normaliseUrl(row.dbUrl),
    authToken: row.dbAuthToken ?? undefined,
  };
}

// Process-wide cache: every module resolving a tenant shares one connection per
// resolved URL, rather than each route bundle opening its own.
const globalForDb = globalThis as unknown as {
  __appDbCache?: Map<string, AppDatabase>;
};
const cache: Map<string, AppDatabase> =
  globalForDb.__appDbCache ?? (globalForDb.__appDbCache = new Map());

/**
 * Get the Drizzle client for a tenant's DATA database (singleton per resolved
 * URL). The tenant must already be registered in the catalog.
 */
export async function getDb(tenantId: string): Promise<AppDatabase> {
  const { url, authToken } = await resolveTenant(tenantId);
  const existing = cache.get(url);
  if (existing) return existing;
  const client = createClient({ url, authToken });
  const instance = drizzle(client) as AppDatabase;
  cache.set(url, instance);
  return instance;
}

// Shared-mode convenience export, kept as a TRIPWIRE. Nothing in the template
// imports it: control-plane queries use `catalogDb` (lib/catalog.ts) and
// app-data queries use getDb(tenantId). A per-tenant app that still reaches for
// this export gets a loud, named failure at first query naming both
// replacements — which is exactly how the missing seam was found. Lazy via
// Proxy so importing the module in per-tenant mode never crashes at load time.
let _shared: AppDatabase | null = null;
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop, receiver) {
    if (getTenancyMode() !== "shared") {
      throw new Error(
        "lib/db.ts: `db` is a shared-mode convenience export and this app is in per_tenant mode. " +
          "Use getDb(tenantId) — with the tenant from the session, see lib/tenant-context.ts — " +
          "for app data, or catalogDb (lib/catalog.ts) for accounts, sessions, billing and " +
          "settings. To run this app shared, set TENANCY_MODE=shared.",
      );
    }
    if (_shared === null) {
      const url = process.env.DATABASE_URL;
      /* v8 ignore start -- getTenancyMode() === "shared" without DATABASE_URL is
         the same misconfiguration resolveTenant() names; unreachable via the
         public API because every shared-mode caller hits that check first. */
      if (!url) {
        throw new Error(
          "lib/db.ts: TENANCY_MODE=shared but DATABASE_URL is not set.",
        );
      }
      /* v8 ignore stop */
      _shared = drizzle(
        createClient({
          url: normaliseUrl(url),
          authToken: process.env.DATABASE_AUTH_TOKEN,
        }),
      ) as AppDatabase;
    }
    return Reflect.get(_shared as object, prop, receiver);
  },
});

// Test hook — clear the process-wide client cache. Tests use this between
// environment manipulations so the previous client is not returned from a warm
// cache. Not for production code.
export function __resetDbCacheForTests(): void {
  cache.clear();
  _shared = null;
}
