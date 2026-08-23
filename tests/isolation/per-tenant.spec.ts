// Per-tenant isolation attack (stage0-tenant-isolation, ADR-023 default mode).
//
// WHAT THIS PROVES
// ----------------
// Two tenants get their own database. Each is migrated with the app's own
// tenant-migration path and seeded with its own uniquely named rows. Identity
// for BOTH lives in the shared catalog, which is what makes a per-tenant login
// possible at all. The attack then tries, from five directions, to reach tenant
// B's rows while holding tenant A's identity:
//
//   1. at the storage layer   — is each database actually separate?
//   2. at the resolver        — does getDb(tenantId) hand over the right one?
//   3. over HTTP              — signed in as tenant A, does any data route leak?
//   4. by tampering           — can the caller name the tenant themselves?
//   5. by removing a route    — does an unregistered tenant fall back to a
//                               shared DATABASE_URL sitting right there?
//
// A pass means all five were tried and blocked. Test 3 additionally asserts a
// POSITIVE: tenant A must be able to read its OWN sentinel over HTTP. Without
// that, an app whose data routes all returned 500 would "leak nothing" and pass
// while proving nothing — the failure mode this spec's previous life had.
//
// The route list is DISCOVERED from the app's own `app/` directory, not typed
// into a constant here. A hand-maintained list is a list someone forgets to
// update, and an empty one is what made this spec vacuous for its entire life.
// A route the builder adds is attacked the next time this runs.
//
// WHEN IT SKIPS
// -------------
// Only when the two tenant database URLs are absent — house-starter's own CI
// provisions no tenants. For a real app the build loop always provisions them
// (agents/build/tenant_test_dbs.py in app-business-core), and if it somehow did
// not, the SEC.24 isolation floor converts the resulting skip into a build
// failure. There is no path where this spec passes without attacking.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { migrateCatalog, migrateTenant } from "@/lib/migrate";
import { hashPassword } from "@/lib/password";
import { resolveCatalog, __resetCatalogCacheForTests } from "@/lib/catalog";
import {
  assertValidTenantId,
  getDb,
  getTenancyMode,
  __resetDbCacheForTests,
} from "@/lib/db";
import { tenantMeta } from "@/lib/schema";

const TENANT_A = "TENANT_A";
const TENANT_B = "TENANT_B";

const URL_A = process.env.TENANT_DB_URL_TENANT_A;
const URL_B = process.env.TENANT_DB_URL_TENANT_B;

// The only skip in this file. Everything past it attacks.
test.skip(
  !URL_A || !URL_B,
  "per-tenant isolation attack requires TENANT_DB_URL_TENANT_A and TENANT_DB_URL_TENANT_B",
);

// Sentinels are the canaries: strings that exist in exactly ONE tenant's
// database, so finding one where it does not belong is unambiguous evidence of a
// leak rather than a coincidence.
const SENTINEL_A = "SENTINEL-TENANT-A-a3f92c";
const SENTINEL_B = "SENTINEL-TENANT-B-b7e14d";

const A_EMAIL = "tenant-a-a3f92c@isolation.test";
const B_EMAIL = "tenant-b-b7e14d@isolation.test";
const PASSWORD = "isolation-example-fixture-pw-xK2";

/** Open a raw libSQL client against one database. */
function clientFor(url: string, authToken?: string) {
  return createClient({ url, authToken });
}

/**
 * Register a tenant the way the app itself does: its database migrated with the
 * app's OWN tenant migration, its sentinel row planted in `tenant_meta`, its
 * routing row written to the catalog's `tenants` table, and its user written to
 * the catalog's `users` table with the tenant mapping on it.
 *
 * Deliberately the same shape lib/tenant/provisioner.ts produces, and reached
 * through the app's own migration functions rather than a fixture schema defined
 * here — so a table the builder adds is created, seeded and searched without
 * this file knowing it exists.
 */
async function seedTenant(
  catalog: ReturnType<typeof clientFor>,
  tenantId: string,
  url: string,
  email: string,
  sentinel: string,
) {
  await migrateTenant(url);

  const tenantClient = clientFor(url);
  try {
    // Upsert, not insert. Playwright retries a failed test in a FRESH worker,
    // which re-runs beforeAll against the databases the first attempt already
    // seeded — a plain INSERT turns every retry into a UNIQUE-constraint error
    // and hides the failure the retry was meant to reproduce.
    await tenantClient.execute({
      sql:
        "INSERT INTO tenant_meta (id, tenant_id, label) VALUES (?, ?, ?) " +
        "ON CONFLICT(tenant_id) DO UPDATE SET label = excluded.label",
      args: [`meta-${tenantId}`, tenantId, sentinel],
    });
  } finally {
    tenantClient.close();
  }

  await catalog.execute({
    sql:
      "INSERT INTO tenants (id, db_url, db_auth_token, provisioner, label) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET db_url = excluded.db_url, label = excluded.label",
    args: [tenantId, url, null, "file", sentinel],
  });

  await catalog.execute({
    sql:
      "INSERT INTO users (id, email, password_hash, name, tenant_id) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, " +
      "name = excluded.name, tenant_id = excluded.tenant_id",
    args: [`user-${tenantId}`, email, await hashPassword(PASSWORD), tenantId, tenantId],
  });
}

/** Every row of every table in a database, as one searchable string. */
async function dump(url: string, authToken?: string): Promise<string> {
  const client = clientFor(url, authToken);
  try {
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const chunks: string[] = [];
    for (const row of tables.rows) {
      const name = String(row.name);
      const contents = await client.execute(`SELECT * FROM "${name}"`);
      for (const r of contents.rows) chunks.push(JSON.stringify(r));
    }
    return chunks.join("\n");
  } finally {
    client.close();
  }
}

/**
 * Routes that are public BY DESIGN, or that no browser session can drive. They
 * are excluded because a public page leaking nothing proves nothing — the attack
 * has to land on routes that require a session.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/contact",
  "/reset-password",
  "/reactivate",
  "/api/auth", // NextAuth internals — exercised by the login flow, not attacked directly
  "/api/billing/webhook", // Stripe-signed; unreachable from a browser session
  "/api/health", // deliberately unauthenticated liveness probe
];

/**
 * Discover the app's authenticated data routes by walking `app/`.
 *
 * Next.js App Router: a directory holding `page.tsx` is a page route and one
 * holding `route.ts` is an API route; `(group)` and `@slot` directories are not
 * URL segments. `[dynamic]` segments are skipped — there is no honest value to
 * substitute for another tenant's record id, and a guessed one would test a 404
 * rather than an authorization boundary.
 */
function discoverRoutes(appDir: string): string[] {
  const found: string[] = [];

  function walk(dir: string, urlPath: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.map((e) => e.name);
    if (names.includes("page.tsx") || names.includes("route.ts")) {
      found.push(urlPath === "" ? "/" : urlPath);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith("_") || name.startsWith("[")) continue;
      const segment =
        name.startsWith("(") || name.startsWith("@") ? "" : `/${name}`;
      walk(join(dir, name), urlPath + segment);
    }
  }

  walk(appDir, "");

  return found
    .filter((route) => route !== "/")
    .filter(
      (route) =>
        !PUBLIC_PREFIXES.some((p) => route === p || route.startsWith(`${p}/`)),
    )
    .sort();
}

const DATA_ROUTES = discoverRoutes(join(process.cwd(), "app"));

/** The one route that reads tenant data and returns it — the positive control. */
const TENANT_DATA_ROUTE = "/api/tenant";

/** Sign in through the app's real login form. Returns true when it worked. */
async function loginAs(page: Page, email: string): Promise<boolean> {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForLoadState("networkidle");
  return !new URL(page.url()).pathname.startsWith("/login");
}

test.describe("per-tenant data isolation", () => {
  test.beforeAll(async () => {
    // Two tenants pointed at one database would make every cross-tenant
    // assertion below pass vacuously — the exact failure mode this file exists
    // to stop being. Assert the premise before relying on it.
    expect(
      URL_A,
      "tenant A and tenant B were given the SAME database URL — the attack " +
        "would prove nothing",
    ).not.toBe(URL_B);

    // The catalog is the app's own control plane, resolved exactly as the
    // running server resolves it, so the accounts seeded here are the accounts
    // the login form authenticates against.
    const { url, authToken } = resolveCatalog();
    expect(
      url,
      "the catalog resolved to one of the tenant databases — identity would be " +
        "living in a tenant's data database, which is the shape this seam removes",
    ).not.toBe(URL_A);
    await migrateCatalog(url, authToken);

    const catalog = clientFor(url, authToken);
    try {
      await seedTenant(catalog, TENANT_A, URL_A!, A_EMAIL, SENTINEL_A);
      await seedTenant(catalog, TENANT_B, URL_B!, B_EMAIL, SENTINEL_B);
    } finally {
      catalog.close();
    }
  });

  test("each tenant database holds only its own rows, and identity holds none", async () => {
    // The premise check. If the seeding is broken, every assertion in this file
    // is meaningless — so it is asserted, never assumed.
    const dumpA = await dump(URL_A!);
    const dumpB = await dump(URL_B!);

    expect(dumpA, "tenant A was not seeded").toContain(SENTINEL_A);
    expect(dumpB, "tenant B was not seeded").toContain(SENTINEL_B);
    expect(dumpA, "tenant B's rows are in tenant A's database").not.toContain(
      SENTINEL_B,
    );
    expect(dumpB, "tenant A's rows are in tenant B's database").not.toContain(
      SENTINEL_A,
    );

    // And the split itself: credentials are control-plane data. A password hash
    // sitting in a tenant database would mean the app could not have routed by
    // it, and would put every tenant's identity inside a database that tenant's
    // own code paths open.
    for (const [name, text] of [
      ["A", dumpA],
      ["B", dumpB],
    ] as const) {
      expect(
        text,
        `tenant ${name}'s data database contains an account — identity belongs ` +
          "in the catalog, not the data plane",
      ).not.toContain("@isolation.test");
    }

    const { url, authToken } = resolveCatalog();
    const dumpCatalog = await dump(url, authToken);
    expect(dumpCatalog, "the catalog is missing tenant A's account").toContain(A_EMAIL);
    expect(dumpCatalog, "the catalog is missing tenant B's account").toContain(B_EMAIL);
  });

  test("the resolver never hands one tenant another tenant's data", async () => {
    // The attack at the seam itself: ask the app's OWN resolver for tenant A and
    // tenant B, and prove neither handle can see the other's rows. This is the
    // structural property ADR-023 buys — no query CAN return another tenant's
    // rows, because they are not in the database being queried.
    __resetDbCacheForTests();
    __resetCatalogCacheForTests();

    const rowsA = await (await getDb(TENANT_A)).select().from(tenantMeta).all();
    const rowsB = await (await getDb(TENANT_B)).select().from(tenantMeta).all();

    const labelsA = rowsA.map((r) => r.label);
    const labelsB = rowsB.map((r) => r.label);

    expect(labelsA, "tenant A's own row is missing").toContain(SENTINEL_A);
    expect(labelsB, "tenant B's own row is missing").toContain(SENTINEL_B);
    expect(labelsA, "tenant A's handle returned tenant B's row").not.toContain(
      SENTINEL_B,
    );
    expect(labelsB, "tenant B's handle returned tenant A's row").not.toContain(
      SENTINEL_A,
    );
  });

  test("an authenticated tenant-A user reads their OWN data and never tenant B's", async ({
    page,
  }) => {
    expect(
      DATA_ROUTES.length,
      "no authenticated data routes were discovered under app/ — the attack " +
        "had nothing to aim at. Either this app genuinely has no data layer " +
        '(declare "tenancy": "none" in build-state.json) or route discovery is ' +
        "broken.",
    ).toBeGreaterThan(0);

    const signedIn = await loginAs(page, A_EMAIL);
    expect(
      signedIn,
      `could not sign in as tenant A (${A_EMAIL}) with TENANCY_MODE=` +
        `${getTenancyMode()}. The cross-tenant attack cannot be mounted, so ` +
        "isolation is UNPROVEN — which is not the same as proven safe. The " +
        "usual cause is a missing tenancy seam: modules importing the " +
        "shared-mode `db` export from lib/db.ts (which throws in per-tenant " +
        "mode) instead of catalogDb for control-plane reads and " +
        "getTenantDb() for app data (ADR-023 Mechanism).",
    ).toBe(true);

    // POSITIVE CONTROL, asserted BEFORE the leak checks. An app whose data
    // routes all 500 leaks nothing and would otherwise pass this test while
    // proving that isolation works only in the sense that nothing works.
    const own = await page.goto(TENANT_DATA_ROUTE, { waitUntil: "domcontentloaded" });
    const ownBody = own ? await own.text() : "";
    expect(
      own?.status(),
      `${TENANT_DATA_ROUTE} did not answer 200 to a signed-in tenant-A user — ` +
        "the seam is not carrying the tenant through to a query",
    ).toBe(200);
    expect(
      ownBody,
      `${TENANT_DATA_ROUTE} did not return tenant A's OWN sentinel — the route ` +
        "is not reading the tenant's database, so the leak checks below would " +
        "pass vacuously",
    ).toContain(SENTINEL_A);

    for (const route of DATA_ROUTES) {
      const response = await page.goto(route, {
        waitUntil: "domcontentloaded",
      });
      const body = response ? await response.text() : "";
      expect(body, `route ${route} leaked tenant B's sentinel`).not.toContain(
        SENTINEL_B,
      );
      expect(body, `route ${route} leaked tenant B's email`).not.toContain(
        B_EMAIL,
      );
    }
  });

  test("tampered tenant identifiers are rejected, not normalised", async ({
    page,
  }) => {
    // Every shape that could collide with another tenant's slot after a silent
    // sanitisation, plus the path-traversal family. lib/db.ts::assertValidTenantId
    // is the enforcement point.
    const malformed = [
      "TENANT-A", // punctuation variant that would collide with TENANT_A
      "../TENANT_B", // path traversal
      "TENANT_A/../TENANT_B",
      "TENANT_A\u0000", // null byte
      "TENANT_A ", // trailing whitespace
      "", // empty
    ];

    for (const id of malformed) {
      expect(
        () => assertValidTenantId(id),
        `assertValidTenantId accepted the tampered id ${JSON.stringify(id)}`,
      ).toThrow();
    }

    // A well-formed but foreign tenant id must not be honoured either: the
    // tenant is a server-side fact, never something the caller supplies.
    //
    // SIGNED IN AS TENANT A FIRST, and issued through `page.request` so the
    // session cookie rides along. An anonymous tamper is answered 401 by every
    // authenticated route before it looks at a header, which means it can prove
    // nothing about whether that route trusts the header — the attack has to
    // hold a real, valid session for the tenant it is NOT asking for. (An
    // earlier version of this test used the cookie-less `request` fixture and
    // was, for that reason, unable to see a route that read the tenant straight
    // off the header.)
    const signedIn = await loginAs(page, A_EMAIL);
    expect(signedIn, `could not sign in as tenant A (${A_EMAIL})`).toBe(true);

    const headerAttacks = [TENANT_B, "tenant_b", "TENANT_A", ...malformed];
    for (const route of DATA_ROUTES) {
      for (const id of headerAttacks) {
        const response = await page.request.get(route, {
          // Header values must be ASCII-safe to be sent at all; the malformed
          // shapes are exercised against assertValidTenantId above.
          headers: { "x-tenant-id": id.replace(/[^\x20-\x7e]/g, "") },
        });
        const body = await response.text();
        expect(
          body,
          `${route} carrying x-tenant-id=${JSON.stringify(id)} returned tenant ` +
            "B's sentinel — the tenant is being taken from the caller",
        ).not.toContain(SENTINEL_B);
        expect(
          body,
          `${route} carrying x-tenant-id=${JSON.stringify(id)} returned tenant ` +
            "B's email — the tenant is being taken from the caller",
        ).not.toContain(B_EMAIL);
      }
    }
  });

  test("per-tenant mode never falls back to a shared DATABASE_URL", async () => {
    // The fallback trap. An unregistered tenant must throw, even with a
    // perfectly good DATABASE_URL sitting right there — because the alternative,
    // serving every unrouted caller from one database, looks perfectly healthy
    // right up until two customers see each other's records.
    const savedDatabaseUrl = process.env.DATABASE_URL;
    const savedCatalogUrl = process.env.CATALOG_DATABASE_URL;
    const savedMode = process.env.TENANCY_MODE;
    const catalog = resolveCatalog();

    // Keep the catalog reachable (so the lookup genuinely runs and genuinely
    // finds nothing) while dangling tenant B's database as the tempting shared
    // fallback.
    process.env.CATALOG_DATABASE_URL = catalog.url;
    process.env.DATABASE_URL = URL_B;
    process.env.TENANCY_MODE = "per_tenant";
    __resetDbCacheForTests();
    __resetCatalogCacheForTests();
    try {
      await expect(
        getDb("TENANT_UNPROVISIONED"),
        "an unprovisioned tenant resolved to a database instead of failing closed",
      ).rejects.toThrow(/TENANT_UNPROVISIONED/);
    } finally {
      if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDatabaseUrl;
      if (savedCatalogUrl === undefined) delete process.env.CATALOG_DATABASE_URL;
      else process.env.CATALOG_DATABASE_URL = savedCatalogUrl;
      if (savedMode === undefined) delete process.env.TENANCY_MODE;
      else process.env.TENANCY_MODE = savedMode;
      __resetDbCacheForTests();
      __resetCatalogCacheForTests();
    }
  });
});
