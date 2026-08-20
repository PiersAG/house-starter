// The CATALOG (control-plane) database handle — ADR-023's login→tenant routing
// seam, the half that runs BEFORE any tenant is known.
//
// WHAT LIVES HERE AND WHY
// -----------------------
// One shared database per app holds everything needed to identify and bill a
// caller before a tenant database is opened: `tenants` (the routing table),
// `users` (with the tenant mapping), `revoked_sessions`, `subscriptions`,
// `stripe_events`, `password_reset_tokens`, `access_grants`, the settings
// registry, and the `error_events` sink. See lib/schema.ts for the full split.
//
// A per-tenant app that put identity in the tenant databases could not log
// anyone in: it would have to know the tenant to find the credential, and it
// finds the tenant BY the credential. The catalog breaks that circle.
//
// RESOLUTION
// ----------
//   CATALOG_DATABASE_URL (+ CATALOG_DATABASE_AUTH_TOKEN)   — preferred, explicit
//   DATABASE_URL         (+ DATABASE_AUTH_TOKEN)           — fallback
//
// The fallback is deliberate and is NOT the fail-open pattern lib/db.ts refuses.
// In shared mode DATABASE_URL *is* the one database, and every deploy path
// already injects it, so an app that has not been told about a separate catalog
// keeps working. What is fail-closed is the TENANT side: lib/db.ts never
// consults DATABASE_URL for tenant data (see its resolve()).
//
// Migrations are NOT run here — creating the client is synchronous and side-effect
// free, exactly as lib/db.ts is. Schema is applied out-of-band by
// `npm run db:migrate` / lib/migrate.ts::migrateCatalog.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { AppDatabase } from "@/lib/users";

export interface CatalogConnection {
  url: string;
  authToken?: string;
}

function normaliseUrl(raw: string): string {
  // Tests may pass ":memory:" explicitly; the running app never defaults to
  // in-memory. Any bare filename becomes file:<name>.
  if (raw === ":memory:") return raw;
  if (/^[a-z]+:/i.test(raw)) return raw;
  return `file:${raw}`;
}

/**
 * Resolve the catalog's URL and auth token from the environment. Throws — by
 * name — when neither variable is configured, rather than silently running
 * against an in-memory database that loses every account on restart.
 */
export function resolveCatalog(
  env: NodeJS.ProcessEnv = process.env,
): CatalogConnection {
  const explicit = env.CATALOG_DATABASE_URL;
  if (explicit && explicit.length > 0) {
    return {
      url: normaliseUrl(explicit),
      authToken: env.CATALOG_DATABASE_AUTH_TOKEN ?? env.DATABASE_AUTH_TOKEN,
    };
  }
  const shared = env.DATABASE_URL;
  if (shared && shared.length > 0) {
    return { url: normaliseUrl(shared), authToken: env.DATABASE_AUTH_TOKEN };
  }
  throw new Error(
    "lib/catalog.ts: neither CATALOG_DATABASE_URL nor DATABASE_URL is set. " +
      "The catalog holds accounts, sessions, billing and the tenant registry — " +
      "without it the app cannot authenticate anyone, so it refuses to start a " +
      "query rather than run against a database that does not persist.",
  );
}

// Process-wide singleton, keyed by resolved URL so a test that repoints the
// environment gets a fresh client rather than a warm one for the old URL.
const globalForCatalog = globalThis as unknown as {
  __catalogDbCache?: Map<string, AppDatabase>;
};
const cache: Map<string, AppDatabase> =
  globalForCatalog.__catalogDbCache ?? (globalForCatalog.__catalogDbCache = new Map());

/** The Drizzle client for the catalog database (singleton per resolved URL). */
export function getCatalogDb(env: NodeJS.ProcessEnv = process.env): AppDatabase {
  const { url, authToken } = resolveCatalog(env);
  const existing = cache.get(url);
  if (existing) return existing;
  const instance = drizzle(createClient({ url, authToken })) as AppDatabase;
  cache.set(url, instance);
  return instance;
}

/**
 * Convenience handle for control-plane queries: `catalogDb` reads exactly like
 * the old `db` export at every call site, but names the database it hits.
 *
 * Lazy via Proxy so importing this module never opens a connection at load
 * time — module load stays side-effect free, and a missing configuration
 * surfaces at first query with the named error above rather than as a crash
 * during the Next.js build's page-data collection.
 */
export const catalogDb: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop, receiver) {
    return Reflect.get(getCatalogDb() as object, prop, receiver);
  },
});

/** Test hook — drop the cached catalog client(s). Not for production code. */
export function __resetCatalogCacheForTests(): void {
  cache.clear();
}
