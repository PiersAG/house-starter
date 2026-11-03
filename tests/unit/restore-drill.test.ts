// @vitest-environment node
//
// The timed restore drill measures recovery against the CEO's targets
// (app-business-core issues 752, 345; config/recovery.ts) and fails when the
// restore, the after-restore steps or the app's start fail, or a target is missed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoveryTargets } from "@/config/recovery";
import { exportAll } from "@/lib/backup/export";
import { runDrill } from "@/lib/backup/drill";
import { seedApp, tenantsOf } from "./backup-seed";

let dir: string;
let out: string;
const EXPORTED = Date.parse("2026-11-02T02:30:00Z");

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "drill-test-"));
  out = join(dir, "export");
  const catalogUrl = await seedApp(dir);
  await exportAll({
    app: "proof",
    catalog: { url: catalogUrl },
    outDir: out,
    listTenants: () => tenantsOf(catalogUrl),
    now: () => new Date(EXPORTED),
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A clock that starts at `start` and moves `stepMs` each time it is read. */
function clock(start: number, stepMs: number): () => number {
  let t = start;
  return () => (t += stepMs);
}

describe("restore drill", () => {
  it("passes when restored, verified and serving within the RTO and RPO targets", async () => {
    const seen: string[] = [];
    const r = await runDrill({
      app: "proof",
      fetchExport: async () => out,
      targetDir: join(dir, "clean"),
      afterRestore: [{ name: "replay deletions", run: async () => void seen.push("replayed") }],
      boot: async (restored) => ({ ok: restored.databases.length === 3 }),
      now: clock(EXPORTED + 6 * 3_600_000, 1000),
    });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["replayed"]);
    expect(r.steps.map((s) => s.name)).toEqual([
      "fetch the newest export",
      "restore into a clean environment and verify",
      "replay deletions",
      "start the app on the restored data",
    ]);
    expect(r.data_age_minutes).toBeCloseTo(360, 0);
    expect(r.within_rpo && r.within_rto).toBe(true);
    expect(r.targets).toEqual({ rto_minutes: recoveryTargets.rtoMinutes, rpo_minutes: recoveryTargets.rpoProviderLostMinutes });
    expect(r.databases).toBe(3);
    expect(r.rows).toBeGreaterThan(0);
  });

  it("fails on data older than the RPO target and on a recovery slower than the RTO target", async () => {
    const stale = await runDrill({
      app: "proof",
      fetchExport: async () => out,
      targetDir: join(dir, "a"),
      boot: async () => ({ ok: true }),
      now: clock(EXPORTED + 2 * 24 * 3_600_000, 1000),
    });
    expect(stale.ok).toBe(false);
    expect(stale.within_rpo).toBe(false);
    expect(stale.problems.join("\n")).toMatch(/minutes old; the target is 1440/);

    const slow = await runDrill({
      app: "proof",
      fetchExport: async () => out,
      targetDir: join(dir, "b"),
      boot: async () => ({ ok: true }),
      now: clock(EXPORTED + 60_000, 60 * 60_000), // an hour passes at every reading
    });
    expect(slow.within_rto).toBe(false);
    expect(slow.problems.join("\n")).toMatch(/recovery took .* minutes; the target is 240/);
  });

  it("fails when the app does not serve, when it is not started, or when a step throws", async () => {
    const down = await runDrill({
      app: "proof",
      fetchExport: async () => out,
      targetDir: join(dir, "a"),
      boot: async () => ({ ok: false, detail: "HTTP 503" }),
      now: clock(EXPORTED + 60_000, 10),
    });
    expect(down.ok).toBe(false);
    expect(down.problems.join("\n")).toMatch(/did not serve on the restored data: HTTP 503/);

    const unbooted = await runDrill({ app: "proof", fetchExport: async () => out, targetDir: join(dir, "b") });
    expect(unbooted.ok).toBe(false);
    expect(unbooted.problems.join("\n")).toMatch(/'the application runs' was not checked/);

    const afterFails = await runDrill({
      app: "proof",
      fetchExport: async () => out,
      targetDir: join(dir, "c"),
      afterRestore: [{ name: "replay deletions", run: async () => { throw new Error("ledger unreadable"); } }],
      boot: async () => ({ ok: true }),
    });
    expect(afterFails.ok).toBe(false);
    expect(afterFails.problems).toContain("replay deletions: ledger unreadable");

    const noExport = await runDrill({
      app: "proof",
      fetchExport: async () => { throw new Error("bucket unreachable"); },
      targetDir: join(dir, "d"),
    });
    expect(noExport.ok).toBe(false);
    expect(noExport.databases).toBe(0);
    expect(noExport.problems[0]).toBe("fetch the newest export: bucket unreachable");
  });

  it("fails a restore whose verification fails", async () => {
    const r = await runDrill({
      app: "proof",
      fetchExport: async () => {
        const { readFileSync, writeFileSync } = await import("node:fs");
        const f = join(out, "tenants", "t_alpha.sql.gz");
        const b = readFileSync(f);
        b[b.length - 1] ^= 0xff;
        writeFileSync(f, b);
        return out;
      },
      targetDir: join(dir, "a"),
      boot: async () => ({ ok: true }),
    });
    expect(r.ok).toBe(false);
    expect(r.steps[1].ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/damaged in storage/);
  });
});
