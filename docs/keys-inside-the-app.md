# Keys inside the app

How an app built from this template holds and uses its keys (bundle S4 of the
factory's security plan: PiersAG/app-business-core#484, #760, #439, #746, #756).

## Each module receives only the keys it needs (#760)

- `lib/key-access.json` lists every key and the files that may read it.
- At server start, `instrumentation.ts` takes every key marked `scrub` out of
  `process.env` (`lib/secrets.ts`). A package in the dependency tree that reads
  `process.env` finds none of them.
- Our own code reads a key with `readSecret("NAME")`. `tests/unit/key-access.test.ts`
  fails when a file reads a key it is not listed for, when server code reads a
  scrubbed key straight from `process.env`, or when a `secret` in `.env.contract`
  has no entry.
- `AUTH_SECRET` stays in the environment: the sign-in library also reads it in the
  Edge middleware, which has no start-up hook.

**Adding a key:** one entry in `lib/key-access.json` (with its readers) and its
line in `.env.contract`. A key the factory generates is also one entry in the
factory's `scaffold/app-keys.json`.

## Keys are replaced every 30 days (decision D7)

- While a key is replaced the old one is readable as `<NAME>_PREVIOUS`.
- Values are sealed under the current key only. A two-factor secret that opens with
  the previous key is re-sealed at once; `npm run db:reseal-secrets` re-seals every
  stored value (two-factor secrets and tenant database tokens). The replacement
  runs it before it drops the old key.

## Tenant database tokens

| Setting | Values | Default | What it does |
|---|---|---|---|
| `TENANT_DB_TOKEN_KEY` | 32 bytes, base64 | not set | The tokens' own key (#484). Tokens are sealed `v2.` under it. Without it they are sealed `v1.` under `MFA_ENCRYPTION_KEY`, as before; `v1.` tokens keep opening and move to `v2.` at the next re-seal. |
| `TENANT_DB_CREDENTIALS` | `short-lived`, `stored` | `short-lived` | `short-lived` (#746; the default since Dispatch AO): nothing is stored in the catalog; each server instance mints a one-hour token for a tenant's database, keeps it in memory, and renews it five minutes before the hour, so no tenant key outlives an hour and the 30-day rule (D7) is met by design. It mints with the app's Turso token, on a rebuilt app the one limited to its own group. `stored` is opt-in: one sealed token per database in the catalog, which never expires and is never re-issued (only its sealing key is replaced), so it does not meet D7 for the tokens. A local `file:` database takes no token in either mode. |
| `TURSO_GROUP` | a group name | not set | The app's own Turso group (#439). New databases go there. With it, `TURSO_API_TOKEN` should be the token limited to that group (factory `agents/turso_app_group.py`). |
| `TURSO_READ_TOKEN` | a token | not set | Read-only Turso token for `npm run db:verify-tenant-backups` (#756). Without it the check uses `TURSO_API_TOKEN` and warns. |

Every issue and every use of a tenant database credential is recorded in the
catalog table `credential_events`: which credential, when, the caller's IP address
when there is a request, and which service (`lib/credential-audit.ts`). Never a
token.

## Deleting a customer's database (#439, #722)

The app's own Turso token can create databases and mint tokens for them, but
not delete them. When an account is erased, or a sign-up is rolled back:

1. the app empties the database and tries to delete it; Turso refuses, and the
   tenant id is listed in the catalog's `tenant_orphans` table
   (`lib/tenant/orphans.ts`);
2. the factory's daily erase job (`.github/workflows/tenant-erase.yml` in
   app-business-core) reads that list with a read-only key for the catalog
   alone, checks again that no account links each id, and deletes the database
   with a key that can delete databases in the app's group and do nothing else.
   It never writes to the catalog, and it deletes at most 10 databases in one run
   (more stops the run, as a brake on a list it did not expect);
3. the app's daily retention job (`/api/cron/retention`) asks Turso whether each
   listed database is still there (`exists()`, read-only) and clears the row once
   Turso answers that it is gone. An unclear answer clears nothing.

**What is not confirmed.** Whether Turso keeps restore points of a deleted
database is not confirmed from its documentation. The factory's off-site copy
keeps the customer's data for its 30-day lock, then removes it. After any
restore, replay the erasure ledger before the app reopens
(`npm run privacy:replay-erasures`).

## Outbound network access (#756)

`lib/egress.ts` checks every connection the server opens against
`lib/egress-allow.json` plus the addresses the environment names (the app's own
address, its databases, its rate-limit store, and `EGRESS_ALLOW`).

| `EGRESS_POLICY` | Default when | What it does |
|---|---|---|
| `enforce` | `VERCEL_ENV` is set (deployed) | Refuses any other host; the request fails with a plain error naming the host, and the refusal is logged. |
| `report` | — | Allows, and logs each host `enforce` would refuse. |
| `off` | locally and in CI | No check. |

**Adding a service:** add its host to `lib/egress-allow.json` with the reason, or
name it in `EGRESS_ALLOW`.
