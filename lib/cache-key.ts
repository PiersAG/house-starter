// Tenant-scoped keys for every cache and shared store (app-business-core issue
// 521; Matt Murphy #113: a cache keyed without the tenant served customer A's
// dashboard to customer B).
//
// The template keeps no data cache today. A feature that adds one — Next.js's
// unstable_cache, a Map kept between requests, a Redis or KV store, a search
// index, a queue — builds every key with tenantCacheKey(), so the tenant is
// always the first part and a key without one cannot be made. The factory's
// security gate fails a cache or shared-store call whose key names no tenant
// (factory.tenant-unscoped-cache-key).

/** Thrown when a cache key is built without a tenant. */
export class MissingTenantKeyError extends Error {
  constructor() {
    super("A cache key must start with the tenant id (lib/cache-key.ts).");
    this.name = "MissingTenantKeyError";
  }
}

const PART = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * `tenant:<tenantId>:<part>:<part>…` — each part checked so one part cannot
 * pose as another (no `:` smuggling a second tenant id in).
 */
export function tenantCacheKey(tenantId: string | null | undefined, ...parts: string[]): string {
  if (!tenantId || !PART.test(tenantId) || tenantId.includes(":")) throw new MissingTenantKeyError();
  for (const p of parts) {
    if (!PART.test(p) || p.includes(":")) {
      throw new Error(`lib/cache-key.ts: a key part must be 1-200 of A-Z a-z 0-9 _ . - (got ${JSON.stringify(p)}).`);
    }
  }
  return ["tenant", tenantId, ...parts].join(":");
}

/** The parts of a key for unstable_cache's key array: the tenant first. */
export function tenantCacheKeyParts(tenantId: string | null | undefined, ...parts: string[]): string[] {
  return tenantCacheKey(tenantId, ...parts).split(":");
}
