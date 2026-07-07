// Tenant PITR (point-in-time restore) verifier — Stage 0 backup baseline
// (spec: wiki/specs/tenancy-migration-fanout.md § Extension, ADR-012).
//
// Enumerates the same tenant set as migrate-all-tenants.ts (`<app_slug>-`
// prefix in the Turso org) and verifies point-in-time restore is enabled on
// each. Fails closed on missing env or missing PITR on any tenant.
//
// Env required: TURSO_API_TOKEN, TURSO_ORG, APP_SLUG (or --app-slug).
// Refuses to run when TENANCY_MODE=shared.

import { writeFileSync } from "node:fs";

const TENANT_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const TURSO_API = "https://api.turso.tech/v1";

type TenantDb = { name: string; tenantId: string; hostname: string };
type TenantBackupStatus = {
  tenant: string;
  dbName: string;
  pitr_enabled: boolean;
  retention_days: number | null;
  error?: string;
};

function parseArgs(argv: string[]): { appSlug: string | null } {
  let appSlug: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--app-slug") appSlug = argv[++i] ?? null;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: db:verify-tenant-backups [--app-slug <slug>]");
      process.exit(0);
    }
  }
  return { appSlug };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    console.error(`[verify-tenant-backups] ${name} is not set — fail-closed.`);
    process.exit(1);
  }
  return v;
}

function refuseIfShared(): void {
  const mode = (process.env.TENANCY_MODE ?? "per_tenant").trim().toLowerCase();
  if (mode === "shared") {
    console.error(
      "[verify-tenant-backups] TENANCY_MODE=shared — no per-tenant enumeration surface. " +
        "Verify PITR on the single shared database via the Turso dashboard or API directly.",
    );
    process.exit(1);
  }
}

async function listTenantDatabases(token: string, org: string, appSlug: string): Promise<TenantDb[]> {
  const r = await fetch(
    `${TURSO_API}/organizations/${encodeURIComponent(org)}/databases`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) {
    throw new Error(`Turso list databases: ${r.status} ${r.statusText}`);
  }
  const body = (await r.json()) as {
    databases?: Array<{ Name?: string; name?: string; Hostname?: string; hostname?: string }>;
  };
  const prefix = `${appSlug}-`;
  const out: TenantDb[] = [];
  for (const d of body.databases ?? []) {
    const name = (d.Name ?? d.name ?? "").trim();
    if (!name.startsWith(prefix)) continue;
    const tenantId = name.slice(prefix.length);
    if (!TENANT_ID_PATTERN.test(tenantId)) continue;
    out.push({ name, tenantId, hostname: (d.Hostname ?? d.hostname ?? "").trim() });
  }
  return out;
}

async function getBackupStatus(
  token: string,
  org: string,
  dbName: string,
): Promise<{ pitr_enabled: boolean; retention_days: number | null }> {
  // Turso exposes DB config including PITR retention. The exact field name has
  // moved between API revisions — the check accepts either `pitr_retention`
  // (older shape) or `point_in_time_restore.retention_days` (newer shape). Any
  // positive integer means PITR is enabled at that retention.
  const r = await fetch(
    `${TURSO_API}/organizations/${encodeURIComponent(org)}/databases/${encodeURIComponent(dbName)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) {
    throw new Error(`Turso get database ${dbName}: ${r.status} ${r.statusText}`);
  }
  const body = (await r.json()) as {
    database?: Record<string, unknown>;
  };
  const d = body.database ?? {};
  const legacy = typeof d["pitr_retention"] === "number" ? (d["pitr_retention"] as number) : null;
  const modern = (d["point_in_time_restore"] as { retention_days?: number } | undefined)?.retention_days ?? null;
  const retention = legacy ?? modern;
  return { pitr_enabled: typeof retention === "number" && retention > 0, retention_days: retention };
}

async function main(): Promise<void> {
  refuseIfShared();
  const args = parseArgs(process.argv.slice(2));
  const apiToken = requireEnv("TURSO_API_TOKEN");
  const org      = requireEnv("TURSO_ORG");
  const appSlug  = args.appSlug ?? process.env.APP_SLUG ?? "";
  if (!appSlug) {
    console.error("[verify-tenant-backups] APP_SLUG not set (and no --app-slug flag) — fail-closed.");
    process.exit(1);
  }

  const tenants = await listTenantDatabases(apiToken, org, appSlug);
  console.log(`[verify-tenant-backups] Discovered ${tenants.length} tenant database(s) under ${appSlug}-.`);

  const results: TenantBackupStatus[] = [];
  for (const t of tenants) {
    try {
      const s = await getBackupStatus(apiToken, org, t.name);
      results.push({ tenant: t.tenantId, dbName: t.name, pitr_enabled: s.pitr_enabled, retention_days: s.retention_days });
      const marker = s.pitr_enabled ? "✓" : "✗";
      console.log(`  ${marker} ${t.tenantId} (${t.name}) — pitr_enabled=${s.pitr_enabled} retention=${s.retention_days}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ tenant: t.tenantId, dbName: t.name, pitr_enabled: false, retention_days: null, error: msg });
      console.error(`  ! ${t.tenantId} (${t.name}) — error: ${msg}`);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    app_slug:     appSlug,
    org:          org,
    counts: {
      total:      results.length,
      pitr_ok:    results.filter((r) => r.pitr_enabled).length,
      pitr_gap:   results.filter((r) => !r.pitr_enabled).length,
    },
    tenants: results,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `pitr-report-${stamp}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`[verify-tenant-backups] Wrote ${reportPath}`);

  const gaps = results.filter((r) => !r.pitr_enabled);
  if (gaps.length > 0) {
    console.error("[verify-tenant-backups] PITR gap on the following tenants:");
    for (const g of gaps) {
      console.error(`  - ${g.tenant} (${g.dbName})${g.error ? ` — ${g.error}` : ""}`);
    }
    process.exit(1);
  }
  console.log("[verify-tenant-backups] All tenants have PITR enabled.");
}

main().catch((err) => {
  console.error("[verify-tenant-backups] Unhandled error:", err);
  process.exit(1);
});
