// Live Drizzle ORM client for the house-starter template — the ADR-023 tenancy
// resolver seam, running fail-closed per stage0-tenant-isolation spec.
//
// Per-tenant is the factory default. Every database access goes through
// getDb(tenantId). A missing TENANT_DB_URL_<TENANTID> throws with the named
// tenant, rather than silently falling through to DATABASE_URL and serving one
// customer's data from another customer's database. Switching an app to shared
// tenancy is an opt-in: set TENANCY_MODE=shared, at which point DATABASE_URL is
// consulted for every tenant.
//
// Resolution:
//   TENANCY_MODE unset OR "per_tenant":
//     TENANT_DB_URL_<TENANTID>  (per-tenant URL, required — throws if absent)
//   TENANCY_MODE = "shared":
//     DATABASE_URL              (single shared DB for every tenant)
//
// tenantId is validated before use — only [A-Za-z0-9_]{1,64} is accepted, so
// path-traversal-shaped IDs ("../", null bytes) and punctuation variants that
// would collide after sanitisation (foo-bar vs foo_bar) are rejected rather
// than silently normalised into another tenant's slot.
//
// Migrations are NOT run here. Creating the client is synchronous; only queries
// are async. Schema is applied out-of-band via `npm run db:migrate`, keeping
// module load synchronous and side-effect free.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { AppDatabase } from "@/lib/users";

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
  if (!raw || raw.length === 0) {
    throw new Error("lib/db.ts: empty database URL");
  }
  if (raw === ":memory:") return raw;
  if (/^[a-z]+:/i.test(raw)) return raw;
  return `file:${raw}`;
}

function resolve(tenantId: string): { url: string; authToken?: string } {
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

  // per_tenant (default) — fail-closed. No DATABASE_URL fallback.
  const envKey = `TENANT_DB_URL_${tenantId}`;
  const perTenant = process.env[envKey];
  if (!perTenant) {
    throw new Error(
      `lib/db.ts: ${envKey} is not set for tenant ${JSON.stringify(tenantId)}. ` +
        `Per-tenant mode requires an explicit database URL per tenant (ADR-023). ` +
        `DATABASE_URL is NOT consulted in per-tenant mode — set TENANCY_MODE=shared ` +
        `to opt into shared tenancy.`,
    );
  }
  return {
    url: normaliseUrl(perTenant),
    authToken: process.env[`TENANT_DB_AUTH_TOKEN_${tenantId}`],
  };
}

// Process-wide cache: every module importing a tenant's db shares one connection
// per resolved URL, rather than each route bundle opening its own.
const globalForDb = globalThis as unknown as {
  __appDbCache?: Map<string, AppDatabase>;
};
const cache: Map<string, AppDatabase> =
  globalForDb.__appDbCache ?? (globalForDb.__appDbCache = new Map());

/** Get the Drizzle client for a tenant (singleton per resolved URL). */
export function getDb(tenantId: string): AppDatabase {
  const { url, authToken } = resolve(tenantId);
  const existing = cache.get(url);
  if (existing) return existing;
  const client = createClient({ url, authToken });
  const instance = drizzle(client) as AppDatabase;
  cache.set(url, instance);
  return instance;
}

// Shared-mode convenience export: single default DB for apps deliberately run
// shared. In per-tenant mode any access throws — the export exists for API
// compatibility but must not be reached. Lazy via Proxy so importing this
// module in per-tenant mode never crashes at load time; only the first
// query-time access surfaces the misuse loudly and by name.
let _shared: AppDatabase | null = null;
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop, receiver) {
    if (getTenancyMode() !== "shared") {
      throw new Error(
        "lib/db.ts: `db` is a shared-mode convenience export and this app is in per_tenant mode. " +
          "Use getDb(tenantId) instead. To run this app shared, set TENANCY_MODE=shared.",
      );
    }
    _shared ??= getDb("__shared__");
    return Reflect.get(_shared as object, prop, receiver);
  },
});

// Test hook — clear the process-wide client cache. Tests use this between
// TENANT_DB_URL_* env manipulations so the previous client is not returned
// from a warm cache. Not for production code.
export function __resetDbCacheForTests(): void {
  cache.clear();
  _shared = null;
}
