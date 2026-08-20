// Catalog (control-plane) connection tests — ADR-023.
//
// The catalog is where identity, billing and the tenant registry live, so the
// two things worth pinning are: WHICH database it resolves to, and that it
// refuses to resolve to nothing. A silently-unconfigured catalog would run
// against an in-memory database and lose every account at the next cold start,
// which is the failure this module's named error exists to prevent.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetCatalogCacheForTests,
  catalogDb,
  getCatalogDb,
  resolveCatalog,
} from "@/lib/catalog";

const CLEARED_KEYS = [
  "CATALOG_DATABASE_URL",
  "CATALOG_DATABASE_AUTH_TOKEN",
  "DATABASE_URL",
  "DATABASE_AUTH_TOKEN",
];

function clearEnv() {
  for (const key of CLEARED_KEYS) delete process.env[key];
  __resetCatalogCacheForTests();
}

beforeEach(clearEnv);
afterEach(clearEnv);

describe("resolveCatalog", () => {
  it("prefers CATALOG_DATABASE_URL over DATABASE_URL", () => {
    process.env.CATALOG_DATABASE_URL = "file:catalog.db";
    process.env.DATABASE_URL = "file:shared.db";
    expect(resolveCatalog().url).toBe("file:catalog.db");
  });

  it("falls back to DATABASE_URL, which every deploy path already injects", () => {
    process.env.DATABASE_URL = "libsql://shared.example.test";
    process.env.DATABASE_AUTH_TOKEN = "shared-token-not-real";
    expect(resolveCatalog()).toEqual({
      url: "libsql://shared.example.test",
      authToken: "shared-token-not-real",
    });
  });

  it("uses CATALOG_DATABASE_AUTH_TOKEN when given, DATABASE_AUTH_TOKEN otherwise", () => {
    process.env.CATALOG_DATABASE_URL = "libsql://catalog.example.test";
    process.env.DATABASE_AUTH_TOKEN = "fallback-token-not-real";
    expect(resolveCatalog().authToken).toBe("fallback-token-not-real");

    process.env.CATALOG_DATABASE_AUTH_TOKEN = "catalog-token-not-real";
    expect(resolveCatalog().authToken).toBe("catalog-token-not-real");
  });

  it("normalises a bare path to a file: URL and leaves :memory: alone", () => {
    process.env.CATALOG_DATABASE_URL = "local.db";
    expect(resolveCatalog().url).toBe("file:local.db");

    process.env.CATALOG_DATABASE_URL = ":memory:";
    expect(resolveCatalog().url).toBe(":memory:");
  });

  it("throws, naming both variables, when neither is configured", () => {
    expect(() => resolveCatalog()).toThrowError(/CATALOG_DATABASE_URL/);
    expect(() => resolveCatalog()).toThrowError(/DATABASE_URL/);
  });

  it("treats an empty value as unset rather than as a URL", () => {
    process.env.CATALOG_DATABASE_URL = "";
    process.env.DATABASE_URL = "";
    expect(() => resolveCatalog()).toThrowError(/neither/);
  });
});

describe("getCatalogDb", () => {
  it("returns the same client for the same resolved URL", () => {
    process.env.CATALOG_DATABASE_URL = ":memory:";
    expect(getCatalogDb()).toBe(getCatalogDb());
  });

  it("opens a new client when the environment repoints the catalog", () => {
    process.env.CATALOG_DATABASE_URL = ":memory:";
    const first = getCatalogDb();
    process.env.CATALOG_DATABASE_URL = "file:other-catalog.db";
    expect(getCatalogDb()).not.toBe(first);
  });
});

describe("catalogDb proxy", () => {
  it("is inert at import time and resolves on first property access", () => {
    // No catalog configured and nothing has thrown yet — importing this module
    // must never open a connection, or the Next.js build's page-data collection
    // would crash on a machine with no database.
    expect(() => (catalogDb as unknown as { select: unknown }).select).toThrowError(
      /neither CATALOG_DATABASE_URL nor DATABASE_URL/,
    );

    process.env.CATALOG_DATABASE_URL = ":memory:";
    expect((catalogDb as unknown as { select: unknown }).select).toBeDefined();
  });
});
