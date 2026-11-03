// Shared by the backup, restore and drill tests: a catalog and tenants made with
// the app's own migrations, holding values that are hard to copy faithfully.
// Not a test file itself (no .test suffix).

import { join } from "node:path";
import { createClient } from "@libsql/client";
import { migrateCatalog, migrateTenant } from "@/lib/migrate";
import type { TenantTarget } from "@/lib/backup/export";

/** A catalog with two tenants, each holding rows that are hard to copy faithfully. */
export async function seedApp(root: string, tenantIds = ["t_alpha", "t_beta"]): Promise<string> {
  const catalogUrl = `file:${join(root, "catalog.db")}`;
  await migrateCatalog(catalogUrl);
  const catalog = createClient({ url: catalogUrl });
  for (const id of tenantIds) {
    const url = `file:${join(root, `${id}.db`)}`;
    await migrateTenant(url);
    const t = createClient({ url });
    await t.execute({
      sql: "INSERT INTO tenant_meta (id, tenant_id, label) VALUES (?, ?, ?)",
      args: [`m-${id}`, id, "Owner's \"dog\" club — ü ✓\nsecond line"],
    });
    await t.execute({
      sql: "INSERT INTO record_events (id, entity, entity_key, action, version, actor, data, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["e1", "client", "c1", "created", 1, "owner", JSON.stringify({ note: "it's ok", n: 0.1 }), 1_700_000_000],
    });
    t.close();
    await catalog.execute({
      sql: "INSERT INTO tenants (id, db_url, label) VALUES (?, ?, ?)",
      args: [id, url, `Tenant ${id}`],
    });
  }
  catalog.close();
  return catalogUrl;
}

export async function tenantsOf(catalogUrl: string): Promise<TenantTarget[]> {
  const c = createClient({ url: catalogUrl });
  const r = await c.execute("SELECT id, db_url FROM tenants ORDER BY id");
  c.close();
  return r.rows.map((x) => ({ tenantId: String(x.id), url: String(x.db_url) }));
}

