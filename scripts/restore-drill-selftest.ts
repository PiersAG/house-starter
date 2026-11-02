// The whole recovery path on throwaway test data, before any app holds a real
// customer (app-business-core issues 345 and 752: "one recorded drill per app
// before real user data"). The proof app runs it; so can anyone, any time.
//
//   npx tsx scripts/restore-drill-selftest.ts [--build] [--report drill-report.json] [--port 3100]
//
// --build  build the app first, with the drill-only values (otherwise run
//          `npm run build` yourself before it).
//
// It makes a catalog and three tenants with the app's own migrations and
// fills them with test rows; exports them exactly as the nightly job does;
// then runs the timed drill: restore into a clean folder, verify every row,
// start the built app on the restored copy and require /api/health to pass.
// Exit 0 = recovered and serving within the targets of config/recovery.ts.

// First: lets this script load lib/ modules marked `import "server-only"` (issue 797).
import "./server-only-node.cjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { migrateCatalog, migrateTenant } from "../lib/migrate";
import { bootAndCheck, buildForDrill } from "../lib/backup/boot";
import { runDrill } from "../lib/backup/drill";
import { exportAll } from "../lib/backup/export";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function seed(root: string): Promise<string> {
  const catalogUrl = `file:${join(root, "catalog.db")}`;
  await migrateCatalog(catalogUrl);
  const catalog = createClient({ url: catalogUrl });
  for (const id of ["drill_a", "drill_b", "drill_c"]) {
    const url = `file:${join(root, `${id}.db`)}`;
    await migrateTenant(url);
    const t = createClient({ url });
    await t.execute({
      sql: "INSERT INTO tenant_meta (id, tenant_id, label) VALUES (?, ?, ?)",
      args: [`m-${id}`, id, `Drill tenant ${id} — it's test data`],
    });
    for (let i = 0; i < 50; i++) {
      await t.execute({
        sql: "INSERT INTO record_events (id, entity, entity_key, action, version, actor, data, occurred_at) VALUES (?, ?, ?, 'created', 1, 'drill', ?, ?)",
        args: [`e${i}`, "client", `c${i}`, JSON.stringify({ n: i, note: "drill" }), 1_700_000_000 + i],
      });
    }
    t.close();
    await catalog.execute({ sql: "INSERT INTO tenants (id, db_url, label) VALUES (?, ?, ?)", args: [id, url, id] });
  }
  catalog.close();
  return catalogUrl;
}

async function main(): Promise<void> {
  if (process.argv.includes("--build")) {
    const built = buildForDrill();
    if (!built.ok) {
      console.error(`[restore-drill-selftest] ${built.detail}`);
      process.exit(1);
    }
  }
  const work = mkdtempSync(join(tmpdir(), "drill-selftest-"));
  try {
    const catalogUrl = await seed(join(work));
    const out = join(work, "export");
    const manifest = await exportAll({
      app: "selftest",
      catalog: { url: catalogUrl },
      outDir: out,
      listTenants: async (c) => {
        const r = await c.execute("SELECT id, db_url FROM tenants ORDER BY id");
        return r.rows.map((x) => ({ tenantId: String(x.id), url: String(x.db_url) }));
      },
    });
    console.log(`exported catalog + ${manifest.databases.length - 1} tenants`);
    const report = await runDrill({
      app: "selftest",
      fetchExport: async () => out,
      targetDir: join(work, "restored"),
      boot: (r) => bootAndCheck(r, Number(arg("--port") ?? 3100)),
    });
    const file = arg("--report");
    if (file) writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    for (const s of report.steps) console.log(`${s.ok ? "ok  " : "FAIL"} ${s.name} (${s.seconds}s)${s.detail ? ` — ${s.detail}` : ""}`);
    console.log(
      `recovered in ${report.recovery_minutes} min (target ${report.targets.rto_minutes}); ` +
        `${report.databases} databases, ${report.rows} rows verified`,
    );
    for (const p of report.problems) console.error(`problem: ${p}`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[restore-drill-selftest] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
