// Tenant-scoped cache keys (app-business-core issue 521; Matt Murphy #113: a
// cache keyed without the tenant served customer A's dashboard to customer B).

import { describe, expect, it } from "vitest";
import { MissingTenantKeyError, tenantCacheKey, tenantCacheKeyParts } from "@/lib/cache-key";

describe("cache keys always carry the tenant (issue 521)", () => {
  it("builds tenant-first keys", () => {
    expect(tenantCacheKey("t1", "dashboard", "summary")).toBe("tenant:t1:dashboard:summary");
    expect(tenantCacheKeyParts("t1", "x")).toEqual(["tenant", "t1", "x"]);
  });

  it("refuses a key with no tenant, and a part that tries to smuggle one in", () => {
    for (const t of [null, undefined, "", "a:b"]) expect(() => tenantCacheKey(t, "x")).toThrow(MissingTenantKeyError);
    expect(() => tenantCacheKey("t1", "x:tenant:t2")).toThrow();
    expect(() => tenantCacheKey("t1", "")).toThrow();
  });
});
