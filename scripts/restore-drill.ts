// The timed restore drill, run monthly by the factory's app-restore-drill.yml
// and by hand from docs/recovery.md (app-business-core issues 345, 472, 752).
//
//   npx tsx scripts/restore-drill.ts --src <export folder> [--target <empty dir>]
//       [--boot] [--port 3100] [--report drill-report.json]
//
// --src     an export folder (scripts/backup-export.ts output, as downloaded
//           from the locked bucket).
// --build   build the app first, with the drill-only values.
// --ledger  the deletion record exported from the live catalog BEFORE the
//           restore (`npm run privacy:export-ledger > ledger.json`): replayed on
//           the restored catalog before the app starts, so accounts erased after
//           the backup stay erased (docs/recovery.md § D).
// --boot    start the built app on the restored data
//           and require /api/health to answer 200 with every check passing:
//           "the application runs" (Matt Murphy #88), seen, not assumed.
//
// The drill environment is a throwaway: the app runs with drill-only values
// (no real keys, email logged not sent, no payments), on a local port, against
// the restored files. Exit 0 = recovered within the RTO and RPO targets of
// config/recovery.ts; 1 = anything failed or a target was missed.

// First: lets this script load lib/ modules marked `import "server-only"` (issue 797).
import "./server-only-node.cjs";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrill } from "../lib/backup/drill";
import { bootAndCheck, buildForDrill, ledgerReplayStep } from "../lib/backup/boot";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const src = arg("--src");
  if (!src) {
    console.error("Usage: restore-drill.ts --src <export folder> [--target <dir>] [--build] [--ledger <file>] [--boot] [--report <file>]");
    process.exit(2);
  }
  if (process.argv.includes("--build")) {
    const built = buildForDrill();
    if (!built.ok) {
      console.error(`[restore-drill] ${built.detail}`);
      process.exit(1);
    }
  }
  const target = arg("--target") ?? mkdtempSync(join(tmpdir(), "restore-drill-"));
  const port = Number(arg("--port") ?? 3100);
  const ledger = arg("--ledger");
  const report = await runDrill({
    app: process.env.APP_SLUG ?? "app",
    fetchExport: async () => src,
    targetDir: join(target, "restored"),
    afterRestore: ledger
      ? [
          {
            name: "replay the deletion record on the restored catalog",
            run: async (restored) => {
              if (!existsSync("scripts/erasure-ledger.ts")) throw new Error("this app has no scripts/erasure-ledger.ts");
              await ledgerReplayStep(ledger, port).run(restored);
            },
          },
        ]
      : undefined,
    boot: process.argv.includes("--boot") ? (r) => bootAndCheck(r, port) : undefined,
  });
  const out = arg("--report");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  for (const s of report.steps) console.log(`${s.ok ? "ok  " : "FAIL"} ${s.name} (${s.seconds}s)${s.detail ? ` — ${s.detail}` : ""}`);
  console.log(
    `recovered in ${report.recovery_minutes} min (target ${report.targets.rto_minutes}); ` +
      `data ${report.data_age_minutes} min old (target ${report.targets.rpo_minutes}); ` +
      `${report.databases} database(s), ${report.rows} row(s)`,
  );
  for (const p of report.problems) console.error(`problem: ${p}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[restore-drill] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
