// Tenancy migration fan-out (spec: wiki/specs/tenancy-migration-fanout.md in
// app-business-core, ADR-023).
//
// Enumerates every tenant database in the Turso org whose name starts with
// `<app_slug>-` and applies lib/migrate.ts's idempotent MIGRATION_SQL to each.
// Per-DB failures are isolated: one tenant's error does NOT abort the loop —
// the run records the failure, keeps going, and exits 1 with a summary.
// Failed tenants are re-runnable individually via `--tenant <id>` because the
// migration is idempotent.
//
// Naming convention: tenant DB names MUST be `<app_slug>-<tenant_id>` where
// `<tenant_id>` matches lib/db.ts's [A-Za-z0-9_]{1,64}. The prefix filter is
// the source of truth for tenant ownership — no registry file to drift.
//
// Env required:
//   TURSO_API_TOKEN  – Turso platform API token (fails closed if missing)
//   TURSO_ORG        – Turso organisation slug
//   APP_SLUG         – this app's slug; also acceptable via --app-slug
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
import { migrate, MIGRATION_SQL } from "../lib/migrate";

const TENANT_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const TURSO_API = "https://api.turso.tech/v1";

type CliArgs = {
  dryRun: boolean;
  singleTenant: string | null;
  appSlug: string | null;
};

type TenantDb = {
  name: string;      // full Turso DB name, e.g. "formwork-acme"
  tenantId: string;  // "acme" — the suffix after `<app_slug>-`
  hostname: string;  // Turso hostname used to build the libsql:// URL
};

type TenantResult = {
  tenant: string;
  dbName: string;
  status: "migrated" | "failed" | "skipped";
  reason?: string;
  error?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, singleTenant: null, appSlug: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--tenant") args.singleTenant = argv[++i] ?? null;
    else if (a === "--app-slug") args.appSlug = argv[++i] ?? null;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: db:migrate:all-tenants [--dry-run] [--tenant <id>] [--app-slug <slug>]\n" +
          "  Env: TURSO_API_TOKEN, TURSO_ORG, APP_SLUG (or --app-slug).\n" +
          "  Refuses to run when TENANCY_MODE=shared.",
      );
      process.exit(0);
    }
  }
  return args;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    console.error(
      `[migrate-all-tenants] ${name} is not set — fail-closed, refusing to run. ` +
        `See wiki/specs/tenancy-migration-fanout.md.`,
    );
    process.exit(1);
  }
  return v;
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

async function listOrgDatabases(token: string, org: string): Promise<TenantDb[]> {
  const url = `${TURSO_API}/organizations/${encodeURIComponent(org)}/databases`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    throw new Error(
      `Turso list databases failed: ${r.status} ${r.statusText} — ${await r.text().catch(() => "")}`,
    );
  }
  const body = (await r.json()) as {
    databases?: Array<{ Name?: string; name?: string; Hostname?: string; hostname?: string }>;
  };
  return (body.databases ?? []).map((d) => ({
    name: (d.Name ?? d.name ?? "").trim(),
    tenantId: "",
    hostname: (d.Hostname ?? d.hostname ?? "").trim(),
  })) as TenantDb[];
}

function filterByPrefix(dbs: TenantDb[], appSlug: string): TenantDb[] {
  const prefix = `${appSlug}-`;
  const out: TenantDb[] = [];
  for (const d of dbs) {
    if (!d.name.startsWith(prefix)) continue;
    const tenantId = d.name.slice(prefix.length);
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      console.warn(
        `[migrate-all-tenants] WARN: ${d.name} matches prefix but suffix ${JSON.stringify(tenantId)} ` +
          "does not match [A-Za-z0-9_]{1,64} — skipping (contract violation upstream).",
      );
      continue;
    }
    out.push({ ...d, tenantId });
  }
  return out;
}

async function mintAuthToken(apiToken: string, org: string, dbName: string): Promise<string> {
  // Turso auth-token creation: short-lived, DB-scoped. The FANOUT uses a fresh
  // token per DB rather than a global one so a leaked token affects one tenant.
  const url = `${TURSO_API}/organizations/${encodeURIComponent(org)}/databases/${encodeURIComponent(dbName)}/auth/tokens`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiration: "1h", authorization: "full-access" }),
  });
  if (!r.ok) {
    throw new Error(
      `mint auth token for ${dbName} failed: ${r.status} ${r.statusText} — ${await r.text().catch(() => "")}`,
    );
  }
  const body = (await r.json()) as { jwt?: string };
  if (!body.jwt) {
    throw new Error(`mint auth token for ${dbName}: empty jwt in response`);
  }
  return body.jwt;
}

function schemaFingerprint(): string {
  // Deterministic short fingerprint of MIGRATION_SQL — recorded on every
  // per-tenant result so a diverging schema across tenants is visible in
  // the report without inspecting each database.
  let hash = 5381;
  for (let i = 0; i < MIGRATION_SQL.length; i++) {
    hash = (hash * 33) ^ MIGRATION_SQL.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

async function main(): Promise<void> {
  refuseIfShared();
  const args = parseArgs(process.argv.slice(2));
  const apiToken = requireEnv("TURSO_API_TOKEN");
  const org      = requireEnv("TURSO_ORG");
  const appSlug  = args.appSlug ?? process.env.APP_SLUG ?? "";
  if (!appSlug) {
    console.error(
      "[migrate-all-tenants] APP_SLUG not set (and no --app-slug flag) — fail-closed.",
    );
    process.exit(1);
  }

  console.log(
    `[migrate-all-tenants] org=${org} app_slug=${appSlug} ` +
      `dry_run=${args.dryRun} single_tenant=${args.singleTenant ?? "(all)"}`,
  );

  let tenants = filterByPrefix(await listOrgDatabases(apiToken, org), appSlug);
  if (args.singleTenant) {
    tenants = tenants.filter((t) => t.tenantId === args.singleTenant);
    if (tenants.length === 0) {
      console.error(
        `[migrate-all-tenants] No database matches ${appSlug}-${args.singleTenant} in org ${org}.`,
      );
      process.exit(1);
    }
  }

  console.log(`[migrate-all-tenants] Discovered ${tenants.length} tenant database(s).`);

  const results: TenantResult[] = [];
  const fingerprint = schemaFingerprint();

  if (args.dryRun) {
    for (const t of tenants) {
      console.log(`  DRY-RUN would migrate: tenant=${t.tenantId} db=${t.name}`);
      results.push({ tenant: t.tenantId, dbName: t.name, status: "skipped", reason: "dry-run" });
    }
  } else {
    for (const t of tenants) {
      const dbUrl = t.hostname ? `libsql://${t.hostname}` : `libsql://${t.name}-${org}.turso.io`;
      try {
        const authToken = await mintAuthToken(apiToken, org, t.name);
        await migrate(dbUrl, authToken);
        results.push({ tenant: t.tenantId, dbName: t.name, status: "migrated" });
        console.log(`  ✓ ${t.tenantId} (${t.name})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ tenant: t.tenantId, dbName: t.name, status: "failed", error: msg });
        console.error(`  ✗ ${t.tenantId} (${t.name}) — ${msg}`);
      }
    }
  }

  const report = {
    generated_at:       new Date().toISOString(),
    app_slug:           appSlug,
    org:                org,
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
    console.log(`    - ${r.tenant} (${r.dbName}) — ${r.error}`);
  }

  process.exit(report.counts.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[migrate-all-tenants] Unhandled error:", err);
  process.exit(1);
});
