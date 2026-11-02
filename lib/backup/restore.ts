// Restore an off-provider export into a clean environment, and prove it
// (app-business-core issues 345, 472, 752; Matt Murphy #88: "a clean environment
// restore into it verify the data is intact"; #200: "download it spin up a fresh
// instance load that data and verify those tables").
//
// Every database in the manifest is loaded into a NEW, EMPTY database, then
// verified four ways, each the effect itself rather than something next to it:
//   1. the stored file's SHA-256 matches the manifest (nothing changed in storage);
//   2. SQLite's integrity and foreign-key checks pass;
//   3. every table holds the number of rows the export counted;
//   4. the restored database, dumped again, gives the SAME SHA-256 as the export —
//      every row and every value is back exactly as it was.

import "server-only";

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { createClient } from "@libsql/client";
import {
  countRows,
  dumpDatabase,
  integrityProblems,
  loadDump,
  sha256,
} from "@/lib/backup/dump";
import { MANIFEST_FORMAT, TENANT_ID, type ExportManifest } from "@/lib/backup/export";

export interface RestoredDatabase {
  role: "catalog" | "tenant";
  tenant: string | null;
  url: string;
  problems: string[];
}

export interface RestoreResult {
  ok: boolean;
  manifest: ExportManifest;
  catalogUrl: string;
  databases: RestoredDatabase[];
  /** Plain-English list of everything that failed; empty when ok. */
  problems: string[];
}

export function readManifest(srcDir: string): ExportManifest {
  const m = JSON.parse(readFileSync(join(srcDir, "manifest.json"), "utf8")) as ExportManifest;
  if (m.format !== MANIFEST_FORMAT) {
    throw new Error(`not a house-starter backup (format ${JSON.stringify(m.format)})`);
  }
  return m;
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): string[] {
  const out: string[] = [];
  for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[t] !== b[t]) out.push(`table ${t}: exported ${a[t] ?? "none"} rows, restored ${b[t] ?? "none"}`);
  }
  return out;
}

export interface RestoreOptions {
  srcDir: string;
  /** A folder that does not exist yet, or is empty: the clean environment. */
  targetDir: string;
  /** Point the restored catalog's tenant list at the restored files, so the app
   *  can be started against the restored copy (the drill). A production restore
   *  into new provider databases points it at those instead (docs/recovery.md). */
  repointTenants?: boolean;
}

export async function restoreAll(opts: RestoreOptions): Promise<RestoreResult> {
  const manifest = readManifest(opts.srcDir);
  const target = resolve(opts.targetDir);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`${target} is not empty — a restore goes into a clean environment`);
  }
  mkdirSync(target, { recursive: true });

  const databases: RestoredDatabase[] = [];
  const problems: string[] = [];
  let catalogUrl = "";

  for (const entry of manifest.databases) {
    const name = entry.role === "catalog" ? "catalog" : `tenant-${entry.tenant}`;
    if (entry.role === "tenant" && !TENANT_ID.test(entry.tenant ?? "")) {
      problems.push(`manifest lists a tenant with an unsafe id ${JSON.stringify(entry.tenant)}`);
      continue;
    }
    const url = `file:${join(target, `${name}.db`)}`;
    const found: string[] = [];
    const stored = readFileSync(join(opts.srcDir, entry.file));
    if (sha256(stored) !== entry.stored_sha256) {
      found.push("the stored file does not match its recorded fingerprint (changed or damaged in storage)");
    } else {
      const sql = gunzipSync(stored).toString("utf8");
      if (sha256(sql) !== entry.sha256) found.push("the unpacked copy does not match its recorded fingerprint");
      const client = createClient({ url });
      try {
        await loadDump(client, sql);
        found.push(...(await integrityProblems(client)));
        found.push(...sameCounts(entry.rows, await countRows(client)));
        const again = await dumpDatabase(client);
        if (again.sha256 !== entry.sha256) {
          found.push("the restored data differs from the export (re-dumped fingerprint does not match)");
        }
      } finally {
        client.close();
      }
    }
    if (entry.role === "catalog") catalogUrl = url;
    databases.push({ role: entry.role, tenant: entry.tenant, url, problems: found });
    for (const p of found) problems.push(`${name}: ${p}`);
  }

  if (!catalogUrl) problems.push("the export holds no catalog database");

  if (opts.repointTenants && catalogUrl && manifest.tenancy === "per_tenant") {
    const catalog = createClient({ url: catalogUrl });
    try {
      for (const d of databases.filter((x) => x.role === "tenant")) {
        await catalog.execute({
          sql: "UPDATE tenants SET db_url = ?, db_auth_token = NULL WHERE id = ?",
          args: [d.url, d.tenant],
        });
      }
    } finally {
      catalog.close();
    }
  }

  // Every tenant the restored catalog routes to must have come back.
  if (catalogUrl && manifest.tenancy === "per_tenant") {
    const catalog = createClient({ url: catalogUrl });
    try {
      const listed = await catalog.execute("SELECT id FROM tenants ORDER BY id");
      const back = new Set(databases.filter((d) => d.role === "tenant").map((d) => d.tenant));
      for (const row of listed.rows) {
        const id = String((row as Record<string, unknown>).id);
        if (!back.has(id)) problems.push(`tenant ${id} is in the catalog but not in the export`);
      }
    } finally {
      catalog.close();
    }
  }
  for (const m of manifest.missing) problems.push(`tenant ${m.tenant} was missing from this export: ${m.error}`);

  return { ok: problems.length === 0, manifest, catalogUrl, databases, problems };
}

