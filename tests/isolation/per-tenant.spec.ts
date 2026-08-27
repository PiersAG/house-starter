// Per-tenant isolation attack (stage0-tenant-isolation, ADR-023 default mode).
//
// WHAT THIS PROVES
// ----------------
// Two tenants get their own database. Each is migrated with the app's own
// tenant-migration path and seeded with its own uniquely named rows. Identity
// for BOTH lives in the shared catalog, which is what makes a per-tenant login
// possible at all. The attack then tries, from six directions, to reach tenant
// B's rows while holding tenant A's identity:
//
//   1. at the storage layer   — is each database actually separate?
//   2. at the resolver        — does getDb(tenantId) hand over the right one?
//   3. over HTTP, reading     — signed in as tenant A, does any data route leak?
//   4. over HTTP, WRITING     — signed in as tenant A, can a write reach tenant
//                               B's database, or land in a row every tenant
//                               shares?
//   5. over HTTP, DELETING    — signed in as tenant A, can a DELETE destroy a
//                               record that belongs to tenant B?
//   6. by tampering           — can the caller name the tenant themselves?
//   7. by removing a route    — does an unregistered tenant fall back to a
//                               shared DATABASE_URL sitting right there?
//
// A pass means all seven were tried and blocked. Tests 3, 4 and 5 additionally assert
// a POSITIVE: tenant A must be able to read its OWN sentinel over HTTP, and an
// accepted write must be observed landing in tenant A's OWN database. Without
// those, an app whose data routes all returned 500 would "leak nothing" and pass
// while proving nothing — the failure mode this spec's previous life had. Leg 5
// asserts the same shape for deletion: tenant A must be able to delete its OWN
// record, or "tenant B's rows survived" only means DELETE is broken everywhere.
//
// WHY THE WRITE LEG EXISTS (added by SEC.41)
// -----------------------------------------
// Legs 1-3 and 5-6 are all READS, and route discovery used to drop every
// `[dynamic]` segment — so `/api/settings/[key]` was never attacked at all and
// no cross-tenant WRITE was ever attempted. A real cross-tenant write defect
// (settings written to one shared catalog row visible to every tenant) therefore
// passed this gate green. Leg 4 closes that: it writes a unique sentinel as
// tenant A, then reads the DATABASES back and asks where the sentinel actually
// landed. It needs no knowledge of what the app stores — a write that reaches
// tenant B's database, or that lands in a shared control-plane row carrying no
// attribution to tenant A, fails it whatever the app is.
//
// WHY THE DELETE LEG EXISTS (added by item 16b)
// ---------------------------------------------
// Leg 4 proves a write leaked by FOLLOWING A SENTINEL — a unique string written
// as tenant A, then found (or not) in tenant B's database afterwards. A DELETE
// writes nothing, carries no sentinel, and that method does not apply to it; so
// DELETE stayed out of WRITE_METHODS and `/api/settings/[key]` had its PUT
// attacked on every run while its DELETE — same file, same rows, same
// authorization question — was attacked never. Leg 5 proves the mirror image
// instead: plant a real, deletable resource in tenant B through tenant B's own
// session, aim tenant A at it by the id tenant B's database actually holds, and
// require the row to still be there afterwards.
//
// The route list is DISCOVERED from the app's own `app/` directory, not typed
// into a constant here. A hand-maintained list is a list someone forgets to
// update, and an empty one is what made this spec vacuous for its entire life.
// A route the builder adds is attacked the next time this runs.
//
// And what discovery DROPS is now declared rather than silent (item 16a):
// tests/isolation/route-map.ts holds the exclusions with a reason each, and
// tests/unit/isolation-route-coverage.test.ts fails the build if a writable route
// ends up outside this attack without an explicit, reasoned exemption. That guard
// reads the source tree only, so it runs on the template too — where this spec
// skips.
//
// WHEN IT SKIPS
// -------------
// Only when the two tenant database URLs are absent — house-starter's own CI
// provisions no tenants. For a real app the build loop always provisions them
// (agents/build/tenant_test_dbs.py in app-business-core), and if it somehow did
// not, the SEC.24 isolation floor converts the resulting skip into a build
// failure. There is no path where this spec passes without attacking.

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
import {
  DELETE_METHOD,
  WRITE_METHODS,
  type DiscoveredRoute,
  appDir,
  attackableRoutes,
} from "./route-map";

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

// Write-leg canaries. One per SOURCE of the record id the write was aimed at, so
// the post-write database dumps say not just "a write landed" but "the write
// aimed at THAT tenant's id landed HERE".
//
//   own    — the id came out of tenant A's own database (the caller's own record)
//   cross  — the id came out of tenant B's database (the cross-tenant attack)
//   shared — the id came out of the shared catalog, or was fabricated
const WRITE_SENTINELS = {
  own: "SENTINEL-WRITE-OWN-9c41ab",
  cross: "SENTINEL-WRITE-CROSS-5d70fe",
  shared: "SENTINEL-WRITE-SHARED-2b83cd",
} as const;

type WriteSource = keyof typeof WRITE_SENTINELS;

// WRITE_METHODS (the sentinel-carrying verbs) and DELETE_METHOD (the
// survive-check verb) are declared in ./route-map.ts, next to the coverage guard
// that asserts the app exports no write verb this file fails to attack. Two
// copies of that list would be two lists to keep in step, which is the failure
// item 16a exists to remove.

/** Sentinel written by the DELETE leg's fixtures, one per tenant. Unlike the
 *  write sentinels these mark a row that must be DELETABLE — planted through the
 *  app's own routes so it is a real resource, not a row this file invented. */
const DELETE_SENTINELS = {
  A: "SENTINEL-DELETE-OWN-4f19ea",
  B: "SENTINEL-DELETE-TARGET-8a26bc",
} as const;

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

  // Seed a trial subscription so the paywall (lib/billing/enforce.ts) allows
  // writes to gated routes during the isolation attack. Without this the
  // write-leg positive control below reports zero accepted writes because every
  // POST returns 402, making the cross-tenant write isolation proof vacuous.
  // Status "incomplete" + a future trial_ends_at is the same shape
  // startTrialForNewOwner() (lib/billing/trial.ts) writes at sign-up. Stored as
  // unix epoch SECONDS — the value Drizzle integer({ mode: "timestamp" })
  // round-trips.
  await catalog.execute({
    sql:
      "INSERT INTO subscriptions (id, user_id, status, trial_ends_at, created_at, updated_at) " +
      "VALUES (?, ?, 'incomplete', ?, unixepoch(), unixepoch()) " +
      "ON CONFLICT(user_id) DO UPDATE SET trial_ends_at = excluded.trial_ends_at",
    args: [
      `sub-${tenantId}`,
      `user-${tenantId}`,
      // 90 days from now in unix seconds (Drizzle mode:"timestamp" stores seconds)
      Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
    ],
  });
}

/** One row of one table, kept with its table name and its columns intact. */
type DumpRow = { table: string; row: Record<string, unknown> };

/**
 * Every row of every table in a database.
 *
 * Structured rather than stringified because the write leg has to ask two
 * questions a flat blob cannot answer: which COLUMN a value came from (to pick a
 * plausible substitution for a `[dynamic]` route segment), and whether the row a
 * sentinel landed in carries any attribution to the tenant that wrote it.
 */
async function dumpRows(url: string, authToken?: string): Promise<DumpRow[]> {
  const client = clientFor(url, authToken);
  try {
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const rows: DumpRow[] = [];
    for (const t of tables.rows) {
      const name = String(t.name);
      const contents = await client.execute(`SELECT * FROM "${name}"`);
      for (const r of contents.rows) {
        rows.push({ table: name, row: r as unknown as Record<string, unknown> });
      }
    }
    return rows;
  } finally {
    client.close();
  }
}

/** Every row of every table in a database, as one searchable string. */
async function dump(url: string, authToken?: string): Promise<string> {
  return (await dumpRows(url, authToken))
    .map(({ row }) => JSON.stringify(row))
    .join("\n");
}

/**
 * The routes this attack aims at: every route under `app/` except the ones
 * declared public-by-design in ROUTE_EXCLUSIONS (tests/isolation/route-map.ts,
 * where each exclusion carries its reason).
 *
 * Still DISCOVERED from the app's own source tree, not typed into a constant
 * here — a hand-maintained list is a list someone forgets to update, and an empty
 * one is what made this spec vacuous for its entire life. A route the builder
 * adds is attacked the next time this runs.
 *
 * What is NEW (item 16a) is that the routes discovery drops are now dropped by a
 * declaration rather than silently, and tests/unit/isolation-route-coverage.test.ts
 * fails the build if a WRITABLE route ends up on the dropped side without an
 * explicit, reasoned exemption. Coverage of this attack is asserted, not assumed.
 */
const ALL_ROUTES = attackableRoutes(appDir());

/**
 * The read/tamper legs navigate to routes with a browser, so they take the
 * STATIC routes only — a URL still carrying a literal `[key]` segment is not a
 * URL. This is byte-for-byte the list those legs attacked before SEC.41; the
 * dynamic routes are new surface for the write leg, not a change to theirs.
 */
const DATA_ROUTES = ALL_ROUTES.filter((r) => r.params.length === 0).map(
  (r) => r.path,
);

/**
 * Write targets: API handlers only. A page route accepts a POST too (that is
 * what a server action is), but only carrying an action id the framework mints
 * at build time, which no test can synthesise — so a POST at a page proves
 * nothing. Server-action throttling and authorization are covered elsewhere.
 */
const WRITE_ROUTES = ALL_ROUTES.filter((r) => r.kind === "api");

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

/**
 * Plausible values for one `[dynamic]` route parameter, harvested from a real
 * database dump.
 *
 * The app is not asked what its ids look like and this file does not guess:
 * every candidate is a value the database actually holds. A column whose NAME
 * matches the parameter is the strongest match (`[key]` → `setting_definitions.key`),
 * then the id-shaped columns. Values that would need URL-encoding are dropped —
 * an encoded probe tests the router, not the authorization boundary.
 */
function candidatesFor(rows: DumpRow[], param: string, limit = 3): string[] {
  const exact: string[] = [];
  const idish: string[] = [];

  for (const { row } of rows) {
    for (const [column, value] of Object.entries(row)) {
      if (typeof value !== "string") continue;
      if (!value || value.length > 96) continue;
      if (!/^[A-Za-z0-9._~-]+$/.test(value)) continue;
      if (column === param) exact.push(value);
      else if (column === "id" || column === "key" || column === "slug" || column.endsWith("_id")) {
        idish.push(value);
      }
    }
  }

  return [...new Set([...exact, ...idish])].slice(0, limit);
}

/**
 * Concrete URLs for one discovered route, substituting each parameter from one
 * source's candidate pool. A static route yields itself.
 */
function urlsFor(route: DiscoveredRoute, pool: string[], fallback: string): string[] {
  if (route.params.length === 0) return [route.path];
  const values = pool.length > 0 ? pool : [fallback];
  return [
    ...new Set(
      values.map((value) =>
        route.params.reduce(
          (path, param) =>
            path.replace(
              new RegExp(`\\[+\\.{0,3}${param}\\]+`),
              encodeURIComponent(value),
            ),
          route.path,
        ),
      ),
    ),
  ];
}

/**
 * A request body carrying the sentinel under the field names apps actually use.
 * Best-effort by design: a body an app rejects costs one 400 and proves nothing,
 * while a body it ACCEPTS is exactly what the leg needs. The positive control is
 * what stops "everything was rejected" reading as a pass.
 */
function writeBody(sentinel: string): Record<string, string> {
  return {
    value: sentinel,
    name: sentinel,
    label: sentinel,
    title: sentinel,
    notes: sentinel,
    description: sentinel,
  };
}

/**
 * DELETE targets: the discovered API routes that actually export a DELETE
 * handler (item 16b). Read from the route files themselves rather than guessed,
 * so a new DELETE handler is attacked with no change here — and
 * tests/unit/isolation-route-coverage.test.ts fails the build if a DELETE
 * appears on a route this list would not reach.
 */
const DELETE_ROUTES = ALL_ROUTES.filter(
  (r) => r.kind === "api" && r.methods.includes(DELETE_METHOD),
);

/** API routes that accept a POST, by path — where a new resource comes from. */
const POSTABLE = new Set(
  ALL_ROUTES.filter((r) => r.kind === "api" && r.methods.includes("POST")).map(
    (r) => r.path,
  ),
);

/**
 * The collection a `/thing/[id]` route belongs to: `/thing`. That is where a
 * REST app creates the resource its DELETE route then names, which is how the
 * DELETE leg obtains a target without being told anything about the app.
 * Null when the route does not end in a parameter.
 */
function collectionPathOf(route: DiscoveredRoute): string | null {
  const segments = route.path.split("/");
  const last = segments[segments.length - 1];
  if (!last.startsWith("[")) return null;
  const parent = segments.slice(0, -1).join("/");
  return parent === "" ? null : parent;
}

/** One row, identified by table and full contents, for before/after comparison. */
function rowKey({ table, row }: DumpRow): string {
  return `${table}\u0000${JSON.stringify(row)}`;
}

/** What a planting run produced in one tenant. */
type Planted = {
  /** Concrete DELETE-able URLs that now name a row carrying the sentinel. */
  urls: string[];
  /** The rows carrying the sentinel, as the database holds them. */
  rows: DumpRow[];
  /** Every request tried, with its status — the diagnosis when nothing landed. */
  attempts: string[];
};

/**
 * Create a real, deletable resource in ONE tenant, through the app's own routes,
 * and report the URLs that now address it.
 *
 * THIS IS THE PART ITEM 16b HAD TO SOLVE. A DELETE carries no sentinel — it
 * writes nothing, so "where did it land" has no answer and the write leg's whole
 * method is unavailable. What a deletion CAN be proved by is the opposite: a row
 * that was there before and is there after. That needs a row worth deleting to
 * exist in the victim tenant in the first place, which is what this plants —
 * using only what discovery already knows:
 *
 *   (a) POST the collection (`/api/subjects` for `/api/subjects/[id]`), the REST
 *       shape for "create one of these", then read the tenant's database back and
 *       take the id of whatever row now carries the sentinel; and
 *   (b) PUT/POST the parameterised URL itself, for routes where naming the
 *       resource IS creating it (a settings key is the canonical shape).
 *
 * Nothing here knows what the app stores. Every id used afterwards came out of
 * the tenant's own database, exactly as the write leg's candidates do.
 */
async function plantDeletable(
  page: Page,
  dbUrl: string,
  sentinel: string,
): Promise<Planted> {
  const attempts: string[] = [];
  const before = await dumpRows(dbUrl);
  const send = async (url: string, method: string) => {
    const response = await page.request.fetch(url, {
      method,
      data: writeBody(sentinel),
      headers: { "content-type": "application/json" },
      failOnStatusCode: false,
      timeout: 15_000,
    });
    attempts.push(`${method} ${url} \u2192 ${response.status()}`);
  };

  for (const route of DELETE_ROUTES) {
    const collection = collectionPathOf(route);
    if (collection && POSTABLE.has(collection)) {
      await send(collection, "POST");
    }
    const pool = route.params.flatMap((param) => candidatesFor(before, param, 8));
    if (pool.length > 0) {
      for (const url of urlsFor(route, pool, "")) {
        for (const method of ["PUT", "POST"] as const) {
          if (route.methods.includes(method)) await send(url, method);
        }
      }
    }
  }

  const after = await dumpRows(dbUrl);
  const rows = after.filter(({ row }) => JSON.stringify(row).includes(sentinel));

  const urls = [
    ...new Set(
      DELETE_ROUTES.flatMap((route) => {
        if (route.params.length === 0) return [];
        const pool = route.params.flatMap((param) =>
          candidatesFor(rows, param, 8),
        );
        return pool.length > 0 ? urlsFor(route, pool, "") : [];
      }),
    ),
  ];

  return { urls, rows, attempts };
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

  test("a cross-tenant WRITE is refused, and an accepted write lands in the caller's own database", async ({
    page,
  }) => {
    // THE LEG THAT WAS MISSING. Everything above reads. This one writes, and
    // then looks at the databases themselves rather than at what the app said —
    // the app reporting `{ok: true}` is not evidence about which database the
    // row went into, and the defect this catches reported exactly that.
    expect(
      WRITE_ROUTES.length,
      "no API routes were discovered under app/ — there is nothing to attempt a " +
        "write against, so cross-tenant writes are UNPROVEN. Either this app has " +
        'no API layer (declare "tenancy": "none" in build-state.json) or route ' +
        "discovery is broken.",
    ).toBeGreaterThan(0);

    const catalog = resolveCatalog();

    // Candidate record ids come from the databases themselves, per source. The
    // `cross` pool is the attack: real ids that belong to tenant B, aimed at
    // routes tenant A is allowed to call.
    const pools: Record<WriteSource, DumpRow[]> = {
      own: await dumpRows(URL_A!),
      cross: await dumpRows(URL_B!),
      shared: await dumpRows(catalog.url, catalog.authToken),
    };

    const signedIn = await loginAs(page, A_EMAIL);
    expect(
      signedIn,
      `could not sign in as tenant A (${A_EMAIL}) — the cross-tenant WRITE ` +
        "attack cannot be mounted, so isolation is UNPROVEN, which is not the " +
        "same as proven safe.",
    ).toBe(true);

    const attempts: { url: string; method: string; source: WriteSource; status: number }[] = [];

    for (const route of WRITE_ROUTES) {
      for (const source of ["own", "cross", "shared"] as const) {
        const sentinel = WRITE_SENTINELS[source];
        const urls = urlsFor(
          route,
          route.params.flatMap((param) => candidatesFor(pools[source], param)),
          `isolation-probe-${source}`,
        );
        // A static route is the caller's own scope by definition — attempting it
        // once, as `own`, is the whole of it.
        if (route.params.length === 0 && source !== "own") continue;

        for (const url of urls) {
          for (const method of WRITE_METHODS) {
            const response = await page.request.fetch(url, {
              method,
              data: writeBody(sentinel),
              headers: { "content-type": "application/json" },
              failOnStatusCode: false,
              timeout: 15_000,
            });
            attempts.push({ url, method, source, status: response.status() });
          }
        }
      }
    }

    const afterA = await dumpRows(URL_A!);
    const afterB = await dumpRows(URL_B!);
    const afterCatalog = await dumpRows(catalog.url, catalog.authToken);
    const textOf = (rows: DumpRow[]) =>
      rows.map(({ row }) => JSON.stringify(row)).join("\n");
    const accepted = attempts.filter((a) => a.status >= 200 && a.status < 300);

    // (a) NOTHING tenant A wrote may appear in tenant B's database — whatever id
    //     it was aimed at, whatever the app answered.
    const textB = textOf(afterB);
    for (const [source, sentinel] of Object.entries(WRITE_SENTINELS)) {
      expect(
        textB,
        `a write issued by tenant A (aimed at a ${source}-sourced id) landed in ` +
          "tenant B's DATABASE. This is a cross-tenant write: one customer " +
          "modified another customer's data.",
      ).not.toContain(sentinel);
    }

    // (b) A write may legitimately touch the shared catalog — that is where
    //     control-plane rows live — but only in a row that is ATTRIBUTED to the
    //     tenant that wrote it. A sentinel sitting in a catalog row that names
    //     no tenant and no user is a value every tenant of this app now shares,
    //     which is a cross-tenant write with extra steps. This is precisely the
    //     shape of the settings defect: one `(key, scope, client_id)` row, no
    //     tenant column, written by whoever asked last.
    const attribution = [TENANT_A, `user-${TENANT_A}`, A_EMAIL];
    const strayed = afterCatalog
      .filter(({ row }) => {
        const text = JSON.stringify(row);
        return (
          Object.values(WRITE_SENTINELS).some((s) => text.includes(s)) &&
          !attribution.some((id) => text.includes(id))
        );
      })
      .map(({ table, row }) => `${table}: ${JSON.stringify(row)}`);
    expect(
      strayed,
      "a write issued by tenant A landed in the SHARED CATALOG in a row that " +
        "carries no attribution to tenant A — so every other tenant reads the " +
        "value tenant A just set. App data belongs in the tenant database " +
        "(ADR-023); a control-plane row must name the tenant or user it is for.",
    ).toEqual([]);

    // (c) POSITIVE CONTROL. Without this, an app that answered every write with
    //     a 500 would satisfy (a) and (b) perfectly and prove nothing — the same
    //     vacuity the read leg's positive control exists to stop. The write path
    //     has to be shown WORKING before "no leak" means anything.
    expect(
      accepted.length,
      "not one write attempt was accepted, so the leak checks above passed " +
        "vacuously. Either the app exposes no writable API route (its writes go " +
        "through server actions, which carry a build-time action id no test can " +
        "synthesise — give the write path an API route, or declare " +
        '"tenancy": "none"), or every write is failing for an unrelated reason. ' +
        `Attempts: ${attempts.map((a) => `${a.method} ${a.url} → ${a.status}`).join(", ")}`,
    ).toBeGreaterThan(0);

    const textA = textOf(afterA);
    const landed = accepted.filter((a) => textA.includes(WRITE_SENTINELS[a.source]));
    expect(
      landed.length,
      "a write was ACCEPTED (2xx) but its value is nowhere in tenant A's own " +
        "database — so the app is writing app data somewhere other than the " +
        "caller's tenant database. Check where the accepted route's write went: " +
        "the shared catalog is the usual answer, and it is the wrong one. " +
        `Accepted: ${accepted.map((a) => `${a.method} ${a.url} → ${a.status}`).join(", ")}`,
    ).toBeGreaterThan(0);
  });

  test("a cross-tenant DELETE is refused, and the caller can delete their OWN record", async ({
    page,
    browser,
    baseURL,
  }) => {
    // THE VERB THE ATTACK NEVER ISSUED (item 16b). The write leg proves a leak
    // by following a sentinel: write a unique string as tenant A, then look at
    // the databases and see where it went. A DELETE writes nothing, so it
    // carries no sentinel and that method simply does not apply — which is why
    // DELETE sat outside WRITE_METHODS while `/api/settings/[key]` had its PUT
    // attacked on every run and its DELETE, same handler file and same data,
    // attacked never.
    //
    // A deletion is proved by the mirror image: a row that was in tenant B's
    // database before the attack is still in it after. That needs a target worth
    // deleting, so one is PLANTED in tenant B first — through tenant B's own
    // session and the app's own routes, never by writing to the database behind
    // the app's back — and the attack then aims tenant A at it by the id tenant
    // B's database really holds.
    //
    // And a positive control, for the same reason every other leg has one: an
    // app whose DELETE handlers all 500 would leave every one of tenant B's rows
    // perfectly intact and "pass". So tenant A must be shown DELETING ITS OWN
    // planted row successfully before "tenant B's rows survived" means anything.
    test.skip(
      DELETE_ROUTES.length === 0,
      "no route under app/ exports a DELETE handler — there is no cross-tenant " +
        "deletion to attempt. tests/unit/isolation-route-coverage.test.ts is what " +
        "notices if one is added.",
    );

    const catalog = resolveCatalog();

    // ── plant a deletable resource in the VICTIM tenant ────────────────────
    // Its own browser context: tenant B has to hold a real session to create
    // anything, and tenant A's session must not be disturbed by acquiring it.
    const contextB = await browser.newContext({ baseURL: baseURL ?? undefined });
    let plantedB: Planted;
    try {
      const pageB = await contextB.newPage();
      const signedInB = await loginAs(pageB, B_EMAIL);
      expect(
        signedInB,
        `could not sign in as tenant B (${B_EMAIL}) to plant the deletion target — ` +
          "the cross-tenant DELETE attack cannot be aimed at anything, so it is " +
          "UNPROVEN rather than passing.",
      ).toBe(true);
      plantedB = await plantDeletable(pageB, URL_B!, DELETE_SENTINELS.B);
    } finally {
      await contextB.close();
    }

    expect(
      plantedB.rows.length,
      "tenant B has DELETE routes but no resource could be created at any of " +
        "them, so there is nothing for tenant A to try to delete and this leg " +
        "would pass vacuously. Either the create path needs a field this probe " +
        "does not send, or writes are failing for an unrelated reason. " +
        `Attempts: ${plantedB.attempts.join(", ")}`,
    ).toBeGreaterThan(0);
    expect(
      plantedB.urls.length,
      "tenant B's planted rows carry no id this file can put in a URL, so the " +
        "attack cannot address them. The DELETE route's parameter and the " +
        "created row's columns do not line up — report this rather than working " +
        `around it. Planted rows: ${plantedB.rows.map((r) => r.table).join(", ")}`,
    ).toBeGreaterThan(0);

    // ── plant the ATTACKER's own resource, for the positive control ────────
    // Tenant A's OWN rows are never used as attack ids — deleting them would
    // destroy the write leg's positive control. The only rows tenant A deletes
    // here are the ones this leg planted for the purpose, after the write leg has
    // finished asserting.
    const signedIn = await loginAs(page, A_EMAIL);
    expect(
      signedIn,
      `could not sign in as tenant A (${A_EMAIL}) — the cross-tenant DELETE ` +
        "attack cannot be mounted, so isolation is UNPROVEN, which is not the " +
        "same as proven safe.",
    ).toBe(true);

    const plantedA = await plantDeletable(page, URL_A!, DELETE_SENTINELS.A);
    expect(
      plantedA.rows.length,
      "tenant A could not create a resource of its own to delete, so the " +
        "positive control below cannot run and 'tenant B survived' would prove " +
        `only that deletion is broken everywhere. Attempts: ${plantedA.attempts.join(", ")}`,
    ).toBeGreaterThan(0);

    // ── the attack ────────────────────────────────────────────────────────
    const beforeB = await dumpRows(URL_B!);
    const beforeCatalog = await dumpRows(catalog.url, catalog.authToken);
    const poolCross = beforeB;
    const poolShared = beforeCatalog;

    const crossAttempts: string[] = [];
    const deleteAs = async (url: string, log: string[]) => {
      // No body: a DELETE that carries one is a different request from the one
      // the app's own client sends, and the handler reads its scope from the
      // query string.
      const response = await page.request.fetch(url, {
        method: DELETE_METHOD,
        failOnStatusCode: false,
        timeout: 15_000,
      });
      log.push(`DELETE ${url} \u2192 ${response.status()}`);
    };

    // The sharpest aim first: the exact URLs of the rows tenant B just created.
    for (const url of plantedB.urls) await deleteAs(url, crossAttempts);

    // Then everything else tenant B's database and the shared catalog can name,
    // so a route keyed on something other than the planted resource is covered
    // too.
    for (const route of DELETE_ROUTES) {
      if (route.params.length === 0) continue;
      for (const pool of [poolCross, poolShared]) {
        const values = route.params.flatMap((param) =>
          candidatesFor(pool, param, 8),
        );
        if (values.length === 0) continue;
        for (const url of urlsFor(route, values, "")) {
          if (plantedB.urls.includes(url)) continue;
          await deleteAs(url, crossAttempts);
        }
      }
    }

    // (a) NOT ONE of tenant B's rows may have gone. Row identity is the table
    //     plus the whole row, so a deletion cannot hide behind a column that
    //     happened to match something else.
    const afterB = await dumpRows(URL_B!);
    const survivors = new Set(afterB.map(rowKey));
    const removed = beforeB
      .filter((r) => !survivors.has(rowKey(r)))
      .map(({ table, row }) => `${table}: ${JSON.stringify(row)}`);
    expect(
      removed,
      "a DELETE issued by tenant A REMOVED rows from tenant B's database. This " +
        "is a cross-tenant deletion: one customer destroyed another customer's " +
        `data. Attempts: ${crossAttempts.join(", ")}`,
    ).toEqual([]);

    // The catalog is the other place tenant B exists: its account, its routing
    // row, its subscription. A DELETE that cannot reach tenant B's data database
    // but can unregister tenant B from the control plane is the same customer
    // harmed by a different door.
    const afterCatalog = await dumpRows(catalog.url, catalog.authToken);
    const catalogSurvivors = new Set(afterCatalog.map(rowKey));
    const namesB = (row: Record<string, unknown>) => {
      const text = JSON.stringify(row);
      return text.includes(TENANT_B) || text.includes(B_EMAIL);
    };
    const removedFromCatalog = beforeCatalog
      .filter((r) => namesB(r.row) && !catalogSurvivors.has(rowKey(r)))
      .map(({ table, row }) => `${table}: ${JSON.stringify(row)}`);
    expect(
      removedFromCatalog,
      "a DELETE issued by tenant A removed a SHARED CATALOG row belonging to " +
        "tenant B — their account, tenant registration or subscription. The data " +
        "database is not the only place a tenant can be destroyed from. " +
        `Attempts: ${crossAttempts.join(", ")}`,
    ).toEqual([]);

    // Said again against the planted target by name, because that is the row the
    // attack was actually aimed at and a survivor count alone reads as noise.
    const textB = afterB.map(({ row }) => JSON.stringify(row)).join("\n");
    expect(
      textB,
      "tenant B's planted resource is gone after tenant A attacked its URL — a " +
        "cross-tenant DELETE succeeded.",
    ).toContain(DELETE_SENTINELS.B);
    expect(
      textB,
      "tenant B's seeded sentinel row is gone after the DELETE attack",
    ).toContain(SENTINEL_B);

    // (b) POSITIVE CONTROL. Tenant A deletes its OWN planted rows. Without this,
    //     an app whose DELETE handlers all fail would satisfy (a) perfectly.
    const ownAttempts: string[] = [];
    for (const url of plantedA.urls) await deleteAs(url, ownAttempts);

    const afterA = await dumpRows(URL_A!);
    const stillA = afterA.filter(({ row }) =>
      JSON.stringify(row).includes(DELETE_SENTINELS.A),
    );
    expect(
      stillA.length,
      "tenant A could not delete its OWN record, so the survival of tenant B's " +
        "rows above proves only that DELETE does not work at all. Fix the " +
        "app's own delete path, or this leg is measuring nothing. " +
        `Planted ${plantedA.rows.length} row(s); attempts: ${ownAttempts.join(", ")}`,
    ).toBeLessThan(plantedA.rows.length);

    // And the deletion tenant A was allowed to make must not have reached across
    // either — an over-broad DELETE that clears both tenants is still a leak.
    expect(
      textB,
      "tenant A's OWN delete-probe sentinel is in tenant B's database — the " +
        "planting write crossed tenants before the deletion ever ran",
    ).not.toContain(DELETE_SENTINELS.A);
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
