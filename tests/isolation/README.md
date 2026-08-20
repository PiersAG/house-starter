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
| `per-tenant.spec.ts`    | skipped unless `TENANT_DB_URL_TENANT_A` and `_TENANT_B` are set | Real seeded attack: migrates + seeds each tenant, then attacks from four directions. Routes are discovered from `app/`, not listed by hand. |
| `shared.spec.ts`        | skipped unless `TENANCY_MODE=shared`                            | Same shape for shared-mode apps.                                                                                                            |
| `tests/unit/db.test.ts` | ✓ (Vitest)                                                      | Factory fail-closed proof — the fallback trap the spec calls out.                                                                           |

## Fallback trap

The spec calls out one specific failure mode: with `TENANT_DB_URL_<tenantId>`
unset **but `DATABASE_URL` set**, the app must fail closed rather than silently
serve the misconfigured tenant from the shared URL. That mechanism is guarded
in `lib/db.ts` and pinned by `tests/unit/db.test.ts` — the E2E specs do not
re-verify the same mechanism.

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

## Known gap — the tenancy seam is declared but not built

`per-tenant.spec.ts`'s HTTP leg ("no data route returns another tenant's rows to
an authenticated tenant-A user") **fails on the template as it stands, by
design**. It cannot sign in, because no app code in this template ever calls
`getDb(tenantId)`: every module imports the shared-mode `db` export from
`lib/db.ts`, which throws in per-tenant mode, and no session carries a tenant
identifier. ADR-023 Mechanism describes that seam; it has not been built. The
failure is the honest signal — isolation over HTTP is UNPROVEN, which is not the
same as proven safe — and it stays until the seam lands. The other four legs
(seeding, the resolver attack, identifier tampering, and the DATABASE_URL
fallback trap) pass today.
