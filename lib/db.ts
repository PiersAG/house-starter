// Live Drizzle ORM client for the house-starter template, with the ADR-023
// tenancy resolver seam.
//
// Every database access goes through getDb(tenantId). Per-tenant is the default
// (ADR-023): a customer's requests resolve to that customer's own database.
// Switching an app between per-tenant and shared is a change to THIS FILE only,
// never a rewrite of the query layer.
//
// Resolution order for a tenant's database URL:
//   1. TENANT_DB_URL_<TENANTID>  (per-tenant override, set at provisioning)
//   2. DATABASE_URL              (single shared DB — the shared-exception path)
//   3. file:local.db             (dev default so data survives restarts)
//
// Migrations are NOT run here. Creating the client is synchronous; only queries
// are async. Schema is applied out-of-band (lib/migrate.ts -> scripts/migrate.ts,
// `npm run db:migrate`), keeping module load synchronous and side-effect free.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { AppDatabase } from "@/lib/users";

function normaliseUrl(raw: string | undefined): string {
  // Dev default is a persistent local file so "sign up then log in" works
  // locally. Tests pass ":memory:" explicitly; the running app never defaults
  // to in-memory. Prod sets a hosted libSQL/Turso URL.
  const value = raw && raw.length > 0 ? raw : "file:local.db";
  if (value === ":memory:") return value;
  if (/^[a-z]+:/i.test(value)) return value;
  return `file:${value}`;
}

function resolve(tenantId: string): { url: string; authToken?: string } {
  const key = tenantId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const perTenant = process.env[`TENANT_DB_URL_${key}`];
  if (perTenant) {
    return {
      url: normaliseUrl(perTenant),
      authToken: process.env[`TENANT_DB_AUTH_TOKEN_${key}`],
    };
  }
  return {
    url: normaliseUrl(process.env.DATABASE_URL),
    authToken: process.env.DATABASE_AUTH_TOKEN,
  };
}

// Process-wide cache: every module importing a tenant's db shares one
// connection per resolved URL, rather than each route bundle opening its own.
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

// Shared-exception convenience: a single default DB for apps deliberately run
// shared (brief write_pattern = shared). Backed by DATABASE_URL / file:local.db.
export const db: AppDatabase = getDb("__shared__");
