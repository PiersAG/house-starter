# Recovery runbook: backups, restore, rollback

The steps a person follows at 3am, in order. Every step names the command that
does it. The same steps run by machine every month (the restore drill) and are
timed, so this page is tested, not hoped.

Issues: app-business-core #345, #472, #528, #752, #777, #793.

## The targets (set by the CEO, `config/recovery.ts`)

| What | Target | Why this number |
|---|---|---|
| A bad deploy is undone | **60 seconds** from the rollback command (aim: 30) | Customers see a broken page for a minute, not an hour. |
| Recovery time (RTO): all customer data back from the outside copy, app serving | **4 hours** | One person, no on-call rota. Four hours is a bad morning, not lost customers. |
| Data loss (RPO) when the database provider is fine | **15 minutes** | The provider's point-in-time restore goes back to any moment in its window. |
| Data loss (RPO) when the database provider itself is lost | **24 hours** | The outside copy is taken every night. |

The monthly drill fails when a run misses the recovery time or the data-loss
target. A miss is a CEO decision: change the target, or pay for a faster setup.

## What exists

- **The provider's own copy.** Turso keeps a point-in-time copy of every
  database. `npx tsx scripts/verify-tenant-backups.ts` checks it is on for every
  tenant.
- **The outside copy (#528).** Every night at 02:30 UTC the factory's
  `app-backup.yml` exports every database (`scripts/backup-export.ts`) and
  stores it in a locked bucket at a second provider (AWS, London, in the
  factory's vault account). Each copy is locked for 30 days. Nobody can change
  or delete it in that time, including the owner. Then it expires. A tenant
  that could not be exported turns the job red.
- **The monthly restore drill (#752).** On the 1st of each month the factory's
  `app-restore-drill.yml` restores the newest outside copy that is complete
  and intact (no missing tenant, every file matching its checksum) into an
  empty, throwaway place. It checks every row, starts the app on the restored
  data, times it all and saves the result. Each app is drilled in a run of its
  own, and the app's code runs with no key: only the values in
  `lib/backup/boot.ts` `drillEnv` reach it.

## A. Undo a bad deploy (seconds)

The database is **not** rolled back with the code. That is safe because a
release only ever adds to the database (expand / contract, below).

1. Run the one command. From the factory, it is one click: Actions →
   **App rollback** → Run workflow → the app's name. From the app's folder:

   ```
   npx tsx scripts/rollback.ts --dry-run   # names the current and the previous version
   npx tsx scripts/rollback.ts             # does it, and times it
   ```

   It needs `VERCEL_TOKEN` and `APP_URL`. It is done when the live
   `/api/health` reports the previous version's commit. It prints the seconds
   this took, against the 60-second target.
2. If the command fails, use the dashboard instead. Open vercel.com → the
   project → **Deployments**, find the previous production deployment, then
   **⋯ → Instant Rollback**. Then open `/api/health` and check the `commit` is
   the previous one.
3. Fix forward on a branch. The rolled-back version stays live until a fixed
   release merges.

## B. Bring data back from a moment ago (minutes): the provider is fine

Use this for a bad change, a wrong deletion or a migration that damaged data.

1. Pick the moment just before the damage, in UTC.
2. Make a new database from that moment:
   `turso db create <name>-restored --from-db <name> --timestamp <ISO time>`.
   This leaves the damaged database untouched until the switch. (Turso CLI
   options as documented at docs.turso.tech; the first drill against a live
   app confirms them, #472.)
3. Check the new copy: `npx tsx scripts/restore-drill.ts` checks a downloaded
   export. To check a database directly, compare the tables' row counts with
   what you expect.
4. Point the app at it. For one tenant, change its `db_url` in the catalog's
   `tenants` table. For the catalog itself, change `CATALOG_DATABASE_URL` and
   redeploy.
5. Put deletions back, before the app reopens (step D2).

## C. Bring everything back from the outside copy (hours): the provider is lost

1. **Before anything else, save the deletion record** if the live catalog can
   still be read (D1).
2. Download the newest copy that predates the problem. If a break-in is
   suspected, take one from before it: each copy is locked for 30 days, so
   older ones are still intact.
   `aws s3 sync s3://<bucket>/apps/<app>/<stamp>/ ./restore-src/`
   This needs the restore role. In the factory it is the restore-drill job.
   Check the copy's date against the nightly backup run that made it (the
   factory's `app-backup.yml` run list): the lock stops a copy being deleted,
   not a forged one being added, so a copy no nightly run made is not restored.
3. Check it and restore it into a clean place:
   `npx tsx scripts/restore-drill.ts --src ./restore-src --boot --report drill.json`
   It checks every file's fingerprint and SQLite's own checks. It checks every
   table's row count, and it dumps the restored data again to compare it with
   the export. Then it starts the app on the copy.
4. Load each verified file into a new database at the new provider. Each file
   is plain SQL: `turso db create <name> --from-dump <file.sql>` (unpack it
   with `gunzip` first), or `sqlite3 <file.db> < <file.sql>` anywhere.
5. Point the catalog's `tenants.db_url` at the new databases. Set
   `CATALOG_DATABASE_URL` and redeploy.
6. Put deletions back (D2), then reopen.
7. Write down how long it took and how old the data was. Compare them with the
   targets above.

## D. Deletions must survive a restore

A restore to an earlier point brings back accounts that were erased after it.

1. Before the restore, while the live catalog can be read, save the deletion
   record: `npm run privacy:export-ledger > ledger.json`.
2. After the restore, before the app reopens, replay it on the restored catalog:
   `npm run privacy:replay-erasures -- ledger.json`. The drill does this itself
   when given the record: `npx tsx scripts/restore-drill.ts --src ... --ledger ledger.json --boot`.

A copy in the outside bucket expires after 30 days. So no erased customer's data
outlives the published retention period.

## E. Changing the database safely

Every schema change follows these rules (`lib/migrations/changes.ts`). CI
enforces them (`tests/unit/migration-changes.test.ts`).

- **Expand, then contract.** A release may only add tables, columns or indexes.
  Something is removed only in a later release, once no live version reads it.
  The test refuses the removal while the code still names it. So rolling back
  one version never meets a database it cannot read.
- **The reverse is written with the change.** Each entry gives the SQL that
  takes it back out. CI runs that SQL on a fresh database. Run
  `npx tsx scripts/schema-change-draft.ts` to print the entry a new change needs.
- **Rehearse on a current copy of live data before it runs.**
  `npx tsx scripts/rehearse-migration.ts --report rehearsal.json` copies each
  live database, read-only, into a throwaway file. On the copy it runs this
  release's exact migration and checks no row is lost. Then it reverses the
  migration, checks the copy matches live again, and runs the migration once
  more. The factory's migration workflow does this before every `apply`, and
  stops if any database fails.

## F. The drill, by hand

```
npx tsx scripts/backup-export.ts --out ./export --app <app>
npm run build
npx tsx scripts/restore-drill.ts --src ./export --boot --report drill.json
```

It passes only when the data is verified and the app serves on it, within
both targets.
