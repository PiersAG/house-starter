// @vitest-environment node
//
// The off-provider copy and its restore, end to end on test databases
// (app-business-core issues 528, 345, 472). A catalog and two tenants are made
// with the app's own migrations, filled with awkward values, exported, then
// restored into a clean folder and verified: same fingerprint, same rows.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { migrateCatalog } from "@/lib/migrate";
import { dumpDatabase, loadDump, sqlLiteral } from "@/lib/backup/dump";
import { exportAll } from "@/lib/backup/export";
import { seedApp, tenantsOf } from "./backup-seed";
import { restoreAll } from "@/lib/backup/restore";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backup-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dump", () => {
  it("writes values that read back exactly", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral(12)).toBe("12");
    expect(sqlLiteral(0.1)).toBe("0.1");
    expect(sqlLiteral(BigInt("9007199254740993"))).toBe("9007199254740993");
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(new Uint8Array([0, 255]))).toBe("X'00ff'");
    expect(sqlLiteral(new Uint8Array([1, 2]).buffer)).toBe("X'0102'");
    expect(() => sqlLiteral(Number.NaN)).toThrow(/not finite/);
    expect(() => sqlLiteral({})).toThrow(/unsupported/);
  });

  it("is deterministic and loads only into an empty database", async () => {
    const url = await seedApp(dir);
    const c = createClient({ url });
    const a = await dumpDatabase(c);
    const b = await dumpDatabase(c);
    expect(a.sha256).toBe(b.sha256);
    expect(a.rows.tenants).toBe(2);
    await expect(loadDump(c, a.sql)).rejects.toThrow(/not empty/);
    c.close();
  });

  it("keeps blobs and odd values through a round trip", async () => {
    const src = createClient({ url: `file:${join(dir, "odd.db")}` });
    await src.execute("CREATE TABLE odd (k TEXT PRIMARY KEY, b BLOB, r REAL, i INTEGER)");
    await src.execute({ sql: "INSERT INTO odd VALUES (?, ?, ?, ?)", args: ["x", new Uint8Array([1, 2, 3]), 1.25, -7] });
    await src.execute({ sql: "INSERT INTO odd VALUES (?, ?, ?, ?)", args: ["y", null, null, null] });
    const dump = await dumpDatabase(src);
    const dst = createClient({ url: `file:${join(dir, "odd-copy.db")}` });
    await loadDump(dst, dump.sql);
    expect((await dumpDatabase(dst)).sha256).toBe(dump.sha256);
    src.close();
    dst.close();
  });
});

describe("export and restore", () => {
  it("exports every tenant and restores all of it, verified, into a clean folder", async () => {
    const catalogUrl = await seedApp(join(dir));
    const out = join(dir, "export");
    const manifest = await exportAll({
      app: "proof",
      catalog: { url: catalogUrl },
      outDir: out,
      listTenants: () => tenantsOf(catalogUrl),
      now: () => new Date("2026-11-02T02:30:00Z"),
    });
    expect(manifest.missing).toEqual([]);
    expect(manifest.databases.map((d) => d.tenant)).toEqual([null, "t_alpha", "t_beta"]);
    expect(existsSync(join(out, "tenants", "t_alpha.sql.gz"))).toBe(true);
    // The manifest names databases, sizes and counts — never row content.
    expect(readFileSync(join(out, "manifest.json"), "utf8")).not.toContain("dog");

    const restored = await restoreAll({ srcDir: out, targetDir: join(dir, "clean"), repointTenants: true });
    expect(restored.problems).toEqual([]);
    expect(restored.ok).toBe(true);
    // The restored catalog now routes each tenant to its restored copy.
    const cat = createClient({ url: restored.catalogUrl });
    const rows = await cat.execute("SELECT id, db_url, db_auth_token FROM tenants ORDER BY id");
    cat.close();
    expect(rows.rows.map((r) => String(r.db_url))).toEqual(
      restored.databases.filter((d) => d.role === "tenant").map((d) => d.url),
    );
    expect(rows.rows.every((r) => r.db_auth_token === null)).toBe(true);
    const t = createClient({ url: restored.databases[1].url });
    const label = await t.execute("SELECT label FROM tenant_meta");
    t.close();
    expect(String(label.rows[0].label)).toBe("Owner's \"dog\" club — ü ✓\nsecond line");
  });

  it("lists a tenant whose export failed, and the restore reports it", async () => {
    const catalogUrl = await seedApp(dir);
    const out = join(dir, "export");
    const manifest = await exportAll({
      app: "proof",
      catalog: { url: catalogUrl },
      outDir: out,
      listTenants: async () => [
        ...(await tenantsOf(catalogUrl)),
        { tenantId: "t_gone", url: `file:${join(dir, "no", "such", "dir", "x.db")}` },
        { tenantId: "bad id!", url: "file:x.db" },
      ],
    });
    expect(manifest.missing.map((m) => m.tenant)).toEqual(["t_gone", "bad id!"]);
    const restored = await restoreAll({ srcDir: out, targetDir: join(dir, "clean") });
    expect(restored.ok).toBe(false);
    expect(restored.problems.join("\n")).toMatch(/t_gone was missing/);
  });

  it("refuses a copy changed in storage, a non-empty target and a foreign folder", async () => {
    const catalogUrl = await seedApp(dir, ["t_one"]);
    const out = join(dir, "export");
    await exportAll({ app: "proof", catalog: { url: catalogUrl }, outDir: out, listTenants: () => tenantsOf(catalogUrl) });

    const busy = join(dir, "busy");
    await restoreAll({ srcDir: out, targetDir: busy });
    await expect(restoreAll({ srcDir: out, targetDir: busy })).rejects.toThrow(/not empty/);

    const file = join(out, "tenants", "t_one.sql.gz");
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(file, bytes);
    const damaged = await restoreAll({ srcDir: out, targetDir: join(dir, "clean2") });
    expect(damaged.ok).toBe(false);
    expect(damaged.problems.join("\n")).toMatch(/changed or damaged in storage/);

    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    writeFileSync(join(out, "manifest.json"), JSON.stringify({ ...m, format: "other/9" }));
    await expect(restoreAll({ srcDir: out, targetDir: join(dir, "clean3") })).rejects.toThrow(/not a house-starter backup/);
  });

  it("catches a tenant in the catalog that the export does not hold, and an unsafe tenant id", async () => {
    const catalogUrl = await seedApp(dir, ["t_one", "t_two"]);
    const out = join(dir, "export");
    await exportAll({
      app: "proof",
      catalog: { url: catalogUrl },
      outDir: out,
      listTenants: async () => (await tenantsOf(catalogUrl)).filter((t) => t.tenantId === "t_one"),
    });
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    m.databases.push({ ...m.databases[1], tenant: "../escape" });
    writeFileSync(join(out, "manifest.json"), JSON.stringify(m));
    const r = await restoreAll({ srcDir: out, targetDir: join(dir, "clean") });
    expect(r.problems.join("\n")).toMatch(/t_two is in the catalog but not in the export/);
    expect(r.problems.join("\n")).toMatch(/unsafe id/);
  });

  it("restores a shared-tenancy app's single database", async () => {
    const url = `file:${join(dir, "shared.db")}`;
    await migrateCatalog(url);
    const out = join(dir, "export");
    const manifest = await exportAll({
      app: "proof",
      catalog: { url },
      outDir: out,
      tenancy: "shared",
      listTenants: async () => {
        throw new Error("a shared app lists no tenants");
      },
    });
    expect(manifest.databases).toHaveLength(1);
    const r = await restoreAll({ srcDir: out, targetDir: join(dir, "clean"), repointTenants: true });
    expect(r.ok).toBe(true);
  });
});
