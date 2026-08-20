# Tenant-isolation tests (stage0-tenant-isolation)

Cross-tenant / cross-user data-leak tests. Wired into `test:isolation`, which
the mothership's build-loop runs as a named check on the `db-schema` and `auth`
phases (see `wiki/specs/stage0-tenant-isolation.md`).

The suite is **mode-switched by `TENANCY_MODE`**:

- **`per_tenant`** (factory default, ADR-023) — two tenants provisioned as
  separate libSQL databases. Sentinel rows seeded per tenant. Authenticated as
  a user of tenant A; every data route asserted to return zero of tenant B's
  sentinels. Tampered tenant identifiers (path traversal, punctuation
  collisions, another tenant's key) are rejected loudly, not normalised into
  another tenant's slot.
- **`shared`** (opt-in) — one database, two users. Same shape: authenticated as
  user A; every data route asserts no leakage of user B's sentinels.

Both modes assert that anonymous requests to protected data routes receive a
401 or a redirect — no DB handle is obtained without a session.

## What ships with the template today

| File                    | Runs today                                                      | Notes                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `anon.spec.ts`          | ✓                                                               | Anonymous access to protected routes → redirect / 401. Real behaviour of the shipped app-shell.                                             |
| `per-tenant.spec.ts`    | skipped unless `TENANT_DB_URL_TENANT_A` and `_TENANT_B` are set | Real seeded attack: migrates + seeds each tenant and the catalog, signs in over HTTP, then attacks from five directions. Routes are discovered from `app/`, not listed by hand. |
| `shared.spec.ts`        | skipped unless `TENANCY_MODE=shared`                            | Same shape for shared-mode apps.                                                                                                            |
| `tests/unit/db.test.ts` | ✓ (Vitest)                                                      | Factory fail-closed proof — the fallback trap the spec calls out.                                                                           |

## How the two databases are arranged

Per-tenant apps run on **two kinds of database**, and the attack only means
something if the harness reproduces both:

- the **catalog** — one per app, resolved from `CATALOG_DATABASE_URL` (falling
  back to `DATABASE_URL`). Holds accounts, sessions, billing, the settings
  registry and the `tenants` routing table. This is what login authenticates
  against, which is what makes a per-tenant sign-in possible at all.
- one **tenant database** per customer, whose URL is a row in `tenants`.

The two `TENANT_DB_URL_TENANT_*` variables are the harness's INPUT: the spec
uses them to register two tenants in the catalog, exactly as
`lib/tenant/provisioner.ts` does at sign-up. They are not a resolution path of
their own — `getDb(tenantId)` reads the catalog and nothing else.

## Fallback trap

The spec calls out one specific failure mode: a tenant that is **not registered
in the catalog** while `DATABASE_URL` is set must fail closed, rather than
silently serving that tenant from the shared URL. Guarded in `lib/db.ts`,
pinned by `tests/unit/db.test.ts`, and re-mounted over the real seam by
`per-tenant.spec.ts`'s fifth leg.

## The positive control

The HTTP leg asserts a POSITIVE before it asserts any negative: signed in as
tenant A, `GET /api/tenant` must return **200 carrying tenant A's own
sentinel**. Without it, an app whose data routes all returned 500 would leak
nothing and pass — proving only that nothing works. The negative assertions are
worth exactly as much as that positive one.

## Builder handoff

Nothing to fill in by hand. `per-tenant.spec.ts` used to ship with an empty
`TODO_ROUTES` array that a builder was supposed to populate; nobody ever did, so
the spec skipped in every app ever generated and the check was green having
attacked nothing. That list is gone. The spec now discovers the app's
authenticated routes by walking `app/` (excluding the routes that are public by
design), so a route the builder adds is attacked on the next run.

The build loop supplies the whole envelope:

1. `TENANCY_MODE` is derived from `build-state.json`'s `tenancy` field — the app
   runs in the mode the build declared, not the mode the runner's environment
   happens to hold.
2. For per-tenant apps, two isolated local libSQL databases are created per run
   and exported as `TENANT_DB_URL_TENANT_A` / `TENANT_DB_URL_TENANT_B`
   (`agents/build/tenant_test_dbs.py` in app-business-core), then torn down.
3. `npm run test:isolation` wires it together; the build loop invokes it via the
   check catalogue, and the SEC.24 isolation floor
   (`agents/build/isolation_floor.py`) converts a skipped attack into a build
   failure for any app that declares it holds customer data.

## The seam this attacks

The HTTP leg used to fail on the template by design: no app code called
`getDb(tenantId)`, every module imported the shared-mode `db` export (which
throws in per-tenant mode), and no session carried a tenant — so a per-tenant app
could not sign anyone in and isolation over HTTP was UNPROVEN.

That seam is now built:

- `lib/catalog.ts` — the control-plane handle. Identity, sessions, billing,
  settings and the tenant registry.
- `lib/auth.ts` — authenticates against the catalog and resolves the account's
  tenant BEFORE issuing a session; the tenant id is a JWT claim.
- `lib/tenant-context.ts` — `getTenantDb()`, the one way app code asks for data.
  The tenant comes from the session, never from the caller.
- `lib/db.ts` — `getDb(tenantId)` resolves that tenant's database URL from the
  catalog. A `file:` URL and a `libsql://` URL are indistinguishable to it,
  which is why two local files here test the same routing production performs
  against two Turso databases.
- `lib/tenant/provisioner.ts` — creates a customer's database at sign-up: one
  libSQL file locally and in CI, one real Turso database in a deployed
  environment, never silently the former in place of the latter.

`app/api/tenant/route.ts` is the template's one app-data route and the target of
the positive control above. A builder's own routes are discovered and attacked
alongside it.
