// Rehearse this release's migration on a current copy of every live database,
// before it runs for real (app-business-core issue 777). Run by the factory's
// migration workflow ahead of `apply`, and by hand from docs/recovery.md.
//
//   npx tsx scripts/rehearse-migration.ts [--tenant <id>] [--report rehearsal.json]
//
// Env: CATALOG_DATABASE_URL and its token. Database tokens: DB_READ_TOKEN when
// set — a READ-ONLY token for the app's database group, minted for one hour by
// the factory's migration workflow — for every remote database; otherwise the
// tenants' sealed tokens, opened as scripts/migrate-all-tenants.ts does.
// The live databases are only READ: each is copied into a throwaway local file,
// and the migration, its reverse and the re-run all happen on the copy.
//
// Exit 0 = every database's rehearsal passed; 1 = any failed or a pending change
// cannot be reversed (the migration is not ready to run).

// First: lets this script load lib/ modules marked `import "server-only"` (issue 797).
import "./server-only-node.cjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { resolveCatalog } from "../lib/catalog";
import { openTenantToken } from "../lib/crypto/secret-box";
import { migrateCatalog, migrateTenant } from "../lib/migrate";
import { rehearseMigration, type RehearsalReport } from "../lib/migrations/rehearse";

const TENANT_ID = /^[A-Za-z0-9_]{1,64}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg("--tenant");
  const work = mkdtempSync(join(tmpdir(), "rehearse-"));
  const reports: RehearsalReport[] = [];
  const { url, authToken } = resolveCatalog();
  const readToken = (process.env.DB_READ_TOKEN ?? "").trim();
  const remote = (u: string) => /^(libsql|https?|wss?):/i.test(u);
  const catalog = createClient({ url, authToken: readToken && remote(url) ? readToken : authToken });
  try {
    if (!only) {
      reports.push(
        await rehearseMigration({
          label: "catalog",
          plane: "catalog",
          source: catalog,
          scratchFile: join(work, "catalog.db"),
          migrate: (u) => migrateCatalog(u),
        }),
      );
    }
    const shared = (process.env.TENANCY_MODE ?? "").trim().toLowerCase() === "shared";
    const rows = shared ? { rows: [] } : await catalog.execute("SELECT id, db_url, db_auth_token FROM tenants ORDER BY id");
    for (const row of rows.rows) {
      const r = row as unknown as { id: string; db_url: string; db_auth_token: string | null };
      if (!TENANT_ID.test(r.id) || (only && r.id !== only)) continue;
      const source = createClient({
        url: r.db_url,
        authToken:
          readToken && remote(r.db_url)
            ? readToken
            : r.db_auth_token == null
              ? undefined
              : openTenantToken(r.db_auth_token, r.id),
      });
      try {
        reports.push(
          await rehearseMigration({
            label: `tenant ${r.id}`,
            plane: "tenant",
            source,
            scratchFile: join(work, `tenant-${r.id}.db`),
            migrate: (u) => migrateTenant(u),
          }),
        );
      } finally {
        source.close();
      }
    }
  } finally {
    catalog.close();
    rmSync(work, { recursive: true, force: true });
  }

  const out = arg("--report");
  if (out) writeFileSync(out, JSON.stringify(reports, null, 2) + "\n");
  for (const r of reports) {
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.label}: pending ${r.pending.join(", ") || "none"}`);
    for (const p of r.problems) console.error(`  problem: ${p}`);
  }
  if (only && reports.length === 0) {
    console.error(`no tenant ${only} in the catalog`);
    process.exit(1);
  }
  process.exit(reports.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error("[rehearse-migration] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
