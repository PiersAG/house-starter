// The nightly off-provider copy: every database the app has, exported to plain
// SQL, compressed, and listed in one manifest (app-business-core issue 528; Matt
// Murphy #182/#185: "a backup with the same provider as the database shares its
// failure").
//
// This module only writes a folder. Where the folder goes (the locked bucket) is
// the job's business — the factory's app-backup.yml — so the export stays the
// same whichever storage holds it. Every catalog tenant must come out with a
// dated export; a tenant that could not be exported is listed in
// `missing`, and scripts/backup-export.ts exits non-zero (the job turns RED).

import "server-only";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createClient, type Client } from "@libsql/client";
import { isOffProviderCopyEnabled, offProviderCopy } from "@/config/recovery";
import { dumpDatabase, sha256 } from "@/lib/backup/dump";

export const MANIFEST_FORMAT = "house-starter-backup/1";
export const TENANT_ID = /^[A-Za-z0-9_]{1,64}$/;

export interface DatabaseTarget {
  url: string;
  authToken?: string;
}

export interface TenantTarget extends DatabaseTarget {
  tenantId: string;
}

export interface ManifestEntry {
  /** "catalog" (control plane, or the one database in shared mode) or "tenant". */
  role: "catalog" | "tenant";
  tenant: string | null;
  /** Path inside the export folder. */
  file: string;
  /** SHA-256 of the SQL text: the restore re-dumps and must match it. */
  sha256: string;
  /** SHA-256 of the compressed file as stored: corruption in storage shows here. */
  stored_sha256: string;
  bytes: number;
  rows: Record<string, number>;
}

export interface ExportManifest {
  format: typeof MANIFEST_FORMAT;
  app: string;
  /** When the export started: the age of the data a restore brings back. */
  created_at: string;
  finished_at: string;
  tenancy: "per_tenant" | "shared";
  databases: ManifestEntry[];
  /** Tenants the catalog lists whose export failed. Non-empty = the job fails. */
  missing: { tenant: string; error: string }[];
}

export interface ExportOptions {
  app: string;
  catalog: DatabaseTarget;
  outDir: string;
  tenancy?: "per_tenant" | "shared";
  /** Every tenant database, from the catalog. Injected so the job can mint
   *  read-only tokens and the tests can use files. */
  listTenants: (catalog: Client) => Promise<TenantTarget[]>;
  now?: () => Date;
  /** The switch (config/recovery.ts). Injected for the both-states test. */
  switchConfig?: { enabled: boolean };
}

export class BackupSwitchedOffError extends Error {
  constructor() {
    super(
      "the off-provider copy is switched off in config/recovery.ts — no export was made. " +
        "It is a hidden switch, on in every build; only the CEO turns it off.",
    );
    this.name = "BackupSwitchedOffError";
  }
}

async function exportOne(
  target: DatabaseTarget,
  outDir: string,
  file: string,
  role: ManifestEntry["role"],
  tenant: string | null,
): Promise<ManifestEntry> {
  const client = createClient({ url: target.url, authToken: target.authToken });
  try {
    const dump = await dumpDatabase(client);
    const stored = gzipSync(Buffer.from(dump.sql, "utf8"), { level: 9 });
    writeFileSync(join(outDir, file), stored);
    return {
      role,
      tenant,
      file,
      sha256: dump.sha256,
      stored_sha256: sha256(stored),
      bytes: stored.byteLength,
      rows: dump.rows,
    };
  } finally {
    client.close();
  }
}

export async function exportAll(opts: ExportOptions): Promise<ExportManifest> {
  if (!isOffProviderCopyEnabled(opts.switchConfig ?? offProviderCopy)) {
    throw new BackupSwitchedOffError();
  }
  const now = opts.now ?? (() => new Date());
  const tenancy = opts.tenancy ?? "per_tenant";
  const created = now().toISOString();
  mkdirSync(join(opts.outDir, "tenants"), { recursive: true });

  const databases: ManifestEntry[] = [];
  const missing: ExportManifest["missing"] = [];

  // The catalog first: without it no tenant can be routed to after a restore,
  // so a catalog failure is fatal rather than one more missing line.
  databases.push(await exportOne(opts.catalog, opts.outDir, "catalog.sql.gz", "catalog", null));

  if (tenancy === "per_tenant") {
    const catalog = createClient({ url: opts.catalog.url, authToken: opts.catalog.authToken });
    let tenants: TenantTarget[];
    try {
      tenants = await opts.listTenants(catalog);
    } finally {
      catalog.close();
    }
    for (const t of tenants) {
      if (!TENANT_ID.test(t.tenantId)) {
        missing.push({ tenant: t.tenantId, error: "tenant id is not a plain identifier" });
        continue;
      }
      try {
        databases.push(
          await exportOne(t, opts.outDir, `tenants/${t.tenantId}.sql.gz`, "tenant", t.tenantId),
        );
      } catch (err) {
        // The database's own error text stays in the job log; the manifest names
        // the failure plainly (issue 444).
        console.error(`[backup] tenant ${t.tenantId}:`, err);
        missing.push({ tenant: t.tenantId, error: "export failed (see the job log)" });
      }
    }
  }

  const manifest: ExportManifest = {
    format: MANIFEST_FORMAT,
    app: opts.app,
    created_at: created,
    finished_at: now().toISOString(),
    tenancy,
    databases,
    missing,
  };
  writeFileSync(join(opts.outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
