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

| File | Runs today | Notes |
|---|---|---|
| `anon.spec.ts` | ✓ | Anonymous access to protected routes → redirect / 401. Real behaviour of the shipped app-shell. |
| `per-tenant.spec.ts` | skipped unless `TENANT_DB_URL_TENANT_A` is set | Scaffolded shape with TODO markers for app-specific data routes. |
| `shared.spec.ts` | skipped unless `TENANCY_MODE=shared` | Same shape for shared-mode apps. |
| `tests/unit/db.test.ts` | ✓ (Vitest) | Factory fail-closed proof — the fallback trap the spec calls out. |

## Fallback trap

The spec calls out one specific failure mode: with `TENANT_DB_URL_<tenantId>`
unset **but `DATABASE_URL` set**, the app must fail closed rather than silently
serve the misconfigured tenant from the shared URL. That mechanism is guarded
in `lib/db.ts` and pinned by `tests/unit/db.test.ts` — the E2E specs do not
re-verify the same mechanism.

## Builder handoff

When the builder scaffolds a new app from house-starter:

1. Read the tenancy from `build-state.json` (`tenancy: "per_tenant" | "shared"`).
2. Fill the `TODO_ROUTES` list in the mode-matching spec with the app's real
   data routes (whatever paths the phase spec introduces).
3. Set the required env vars for the isolation run in the app's CI: for
   per_tenant, `TENANT_DB_URL_TENANT_A` and `TENANT_DB_URL_TENANT_B`; for
   shared, `TENANCY_MODE=shared` plus `DATABASE_URL`.
4. The `test:isolation` npm script wires everything together — the build-loop
   invokes it via the check catalogue.
