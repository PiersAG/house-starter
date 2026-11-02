// The nightly off-provider copy, run by the factory's app-backup.yml
// (app-business-core issue 528). Writes every database to a folder; the job
// uploads the folder to the locked bucket.
//
//   npx tsx scripts/backup-export.ts --out <dir> --app <slug>
//
// Env: CATALOG_DATABASE_URL (or DATABASE_URL) and its auth token, TENANCY_MODE.
// Database tokens: when BACKUP_DB_READ_TOKEN is set — a READ-ONLY token for the
// app's database group, minted for one hour by the factory's job — it is used
// for every remote database, so the export can never write to a customer
// database. Otherwise the catalog's stored (sealed) tenant tokens are opened as
// scripts/migrate-all-tenants.ts does (local and test runs).
//
// Exit 0 = every catalog tenant has a dated export; 1 = any tenant is missing,
// the switch is off, or the catalog could not be read (the job goes RED).

// First: lets this script load lib/ modules marked `import "server-only"` (issue 797).
import "./server-only-node.cjs";
import type { Client } from "@libsql/client";
import { resolveCatalog } from "../lib/catalog";
import { openTenantToken } from "../lib/crypto/secret-box";
import { exportAll, TENANT_ID, type TenantTarget } from "../lib/backup/export";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function listTenants(catalog: Client, readToken: string): Promise<TenantTarget[]> {
  const rows = await catalog.execute("SELECT id, db_url, db_auth_token FROM tenants ORDER BY id");
  const out: TenantTarget[] = [];
  for (const row of rows.rows) {
    const r = row as unknown as { id: string; db_url: string; db_auth_token: string | null };
    const remote = /^(libsql|https?|wss?):/i.test(r.db_url);
    let authToken: string | undefined;
    if (remote && readToken) authToken = readToken;
    else if (r.db_auth_token != null && TENANT_ID.test(r.id)) authToken = openTenantToken(r.db_auth_token, r.id);
    out.push({ tenantId: r.id, url: r.db_url, authToken });
  }
  return out;
}

async function main(): Promise<void> {
  const out = arg("--out");
  const app = arg("--app") ?? process.env.APP_SLUG ?? "";
  if (!out || !app) {
    console.error("Usage: backup-export.ts --out <dir> --app <slug>");
    process.exit(2);
  }
  const readToken = (process.env.BACKUP_DB_READ_TOKEN ?? "").trim();
  const tenancy = (process.env.TENANCY_MODE ?? "per_tenant").trim().toLowerCase() === "shared" ? "shared" : "per_tenant";
  const { url, authToken } = resolveCatalog();
  const catalogToken = readToken && /^(libsql|https?|wss?):/i.test(url) ? readToken : authToken;

  const manifest = await exportAll({
    app,
    catalog: { url, authToken: catalogToken },
    outDir: out,
    tenancy,
    listTenants: (c) => listTenants(c, readToken),
  });
  const tenants = manifest.databases.filter((d) => d.role === "tenant").length;
  const bytes = manifest.databases.reduce((n, d) => n + d.bytes, 0);
  console.log(`[backup] ${app}: catalog + ${tenants} tenant database(s), ${bytes} bytes, started ${manifest.created_at}`);
  if (manifest.missing.length) {
    for (const m of manifest.missing) console.error(`[backup] MISSING tenant ${m.tenant}: ${m.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[backup] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
