// Tenancy migration fan-out (spec: wiki/specs/tenancy-migration-fanout.md in
// app-business-core, ADR-023).
//
// Enumerates every tenant in the app's CATALOG and applies lib/migrate.ts's
// idempotent tenant DDL to each one's own database. Per-DB failures are
// isolated: one tenant's error does NOT abort the loop — the run records the
// failure, keeps going, and exits 1 with a summary. Failed tenants are
// re-runnable individually via `--tenant <id>` because the migration is
// idempotent.
//
// WHY THE CATALOG AND NOT THE HOSTING PROVIDER
// --------------------------------------------
// This used to list databases in the Turso org and filter them by an
// `<app_slug>-` name prefix. That made the provider's naming convention a second
// source of truth about which databases belong to this app, and it could only
// ever see Turso-hosted tenants — a file-provisioned tenant (local, CI, a
// self-hosted deployment) was invisible to it. The catalog's `tenants` table is
// the SAME registry lib/db.ts::getDb routes through, so a tenant this fan-out
// migrates is exactly a tenant the app can serve, whatever created it.
//
// Env required:
//   CATALOG_DATABASE_URL (or DATABASE_URL) – the app's control-plane database
//   CATALOG_DATABASE_AUTH_TOKEN (or DATABASE_AUTH_TOKEN) – for a remote catalog
//
// Refuses to run if TENANCY_MODE=shared: a shared app has one database and
// its migration path is `npm run db:migrate` (drizzle-kit).
//
// Exit codes: 0 = all tenants green; 1 = one or more tenants failed OR an
// environment / configuration precondition was missing.
//
// Output: writes migration-report-<ISO>.json to the current working directory
// listing every tenant attempted, the per-tenant result, and the applied
// schema fingerprint — never a bare counter.

import { writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { migrateTenant, TENANT_MIGRATION_SQL } from "../lib/migrate";
import { resolveCatalog } from "../lib/catalog";

const TENANT_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

type CliArgs = {
  dryRun: boolean;
  singleTenant: string | null;
};

type TenantRecord = {
  tenantId: string;
  dbUrl: string;
  authToken?: string;
};

type TenantResult = {
  tenant: string;
  dbUrl: string;
  status: "migrated" | "failed" | "skipped";
  reason?: string;
  error?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, singleTenant: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--tenant") args.singleTenant = argv[++i] ?? null;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: db:migrate:all-tenants [--dry-run] [--tenant <id>]\n" +
          "  Env: CATALOG_DATABASE_URL (or DATABASE_URL).\n" +
          "  Refuses to run when TENANCY_MODE=shared.",
      );
      process.exit(0);
    }
  }
  return args;
}

function refuseIfShared(): void {
  const mode = (process.env.TENANCY_MODE ?? "per_tenant").trim().toLowerCase();
  if (mode === "shared") {
    console.error(
      "[migrate-all-tenants] TENANCY_MODE=shared — this app has one database. " +
        "Use `npm run db:migrate` (drizzle-kit). Refusing to fan out.",
    );
    process.exit(1);
  }
}

/** Every tenant the catalog knows about. */
async function listTenants(): Promise<TenantRecord[]> {
  const { url, authToken } = resolveCatalog();
  const client = createClient({ url, authToken });
  try {
    const rows = await client.execute(
      "SELECT id, db_url, db_auth_token FROM tenants ORDER BY id",
    );
    const out: TenantRecord[] = [];
    for (const row of rows.rows) {
      const r = row as unknown as {
        id: string;
        db_url: string;
        db_auth_token: string | null;
      };
      if (!TENANT_ID_PATTERN.test(r.id)) {
        console.warn(
          `[migrate-all-tenants] WARN: catalog holds tenant id ${JSON.stringify(r.id)}, ` +
            "which does not match [A-Za-z0-9_]{1,64} — skipping (contract violation upstream).",
        );
        continue;
      }
      out.push({
        tenantId: r.id,
        dbUrl: r.db_url,
        authToken: r.db_auth_token ?? undefined,
      });
    }
    return out;
  } finally {
    client.close();
  }
}

function schemaFingerprint(): string {
  // Deterministic short fingerprint of the tenant DDL — recorded on every
  // per-tenant result so a diverging schema across tenants is visible in
  // the report without inspecting each database.
  let hash = 5381;
  for (let i = 0; i < TENANT_MIGRATION_SQL.length; i++) {
    hash = (hash * 33) ^ TENANT_MIGRATION_SQL.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

async function main(): Promise<void> {
  refuseIfShared();
  const args = parseArgs(process.argv.slice(2));

  let tenants: TenantRecord[];
  try {
    tenants = await listTenants();
  } catch (err) {
    console.error(
      "[migrate-all-tenants] could not read the catalog — fail-closed, refusing to run.",
      err,
    );
    process.exit(1);
  }

  if (args.singleTenant) {
    tenants = tenants.filter((t) => t.tenantId === args.singleTenant);
    if (tenants.length === 0) {
      console.error(
        `[migrate-all-tenants] No tenant ${args.singleTenant} in the catalog.`,
      );
      process.exit(1);
    }
  }

  console.log(
    `[migrate-all-tenants] dry_run=${args.dryRun} ` +
      `single_tenant=${args.singleTenant ?? "(all)"}`,
  );
  console.log(`[migrate-all-tenants] Catalog holds ${tenants.length} tenant database(s).`);

  const results: TenantResult[] = [];
  const fingerprint = schemaFingerprint();

  if (args.dryRun) {
    for (const t of tenants) {
      console.log(`  DRY-RUN would migrate: tenant=${t.tenantId}`);
      results.push({
        tenant: t.tenantId,
        dbUrl: t.dbUrl,
        status: "skipped",
        reason: "dry-run",
      });
    }
  } else {
    for (const t of tenants) {
      try {
        await migrateTenant(t.dbUrl, t.authToken);
        results.push({ tenant: t.tenantId, dbUrl: t.dbUrl, status: "migrated" });
        console.log(`  ✓ ${t.tenantId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          tenant: t.tenantId,
          dbUrl: t.dbUrl,
          status: "failed",
          error: msg,
        });
        console.error(`  ✗ ${t.tenantId} — ${msg}`);
      }
    }
  }

  const report = {
    generated_at:       new Date().toISOString(),
    schema_fingerprint: fingerprint,
    dry_run:            args.dryRun,
    single_tenant:      args.singleTenant,
    counts: {
      migrated: results.filter((r) => r.status === "migrated").length,
      failed:   results.filter((r) => r.status === "failed").length,
      skipped:  results.filter((r) => r.status === "skipped").length,
    },
    tenants: results,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `migration-report-${stamp}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`[migrate-all-tenants] Wrote ${reportPath}`);

  console.log("[migrate-all-tenants] Summary:");
  console.log(`  migrated : ${report.counts.migrated}`);
  console.log(`  failed   : ${report.counts.failed}`);
  console.log(`  skipped  : ${report.counts.skipped}`);
  for (const r of results.filter((x) => x.status === "failed")) {
    console.log(`    - ${r.tenant} — ${r.error}`);
  }

  process.exit(report.counts.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[migrate-all-tenants] Unhandled error:", err);
  process.exit(1);
});
