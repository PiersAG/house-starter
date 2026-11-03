// One command: put the previous production version back, and time it
// (app-business-core issue 793). docs/recovery.md § Roll back a bad deploy.
//
//   npx tsx scripts/rollback.ts [--to <deployment id>] [--dry-run] [--report rollback.json]
//
// Env: VERCEL_TOKEN (a token that may manage this project's deployments),
// APP_URL (the production address). The project and team come from
// .vercel/project.json (projectId, orgId), the same identity the deploy uses;
// VERCEL_PROJECT_ID / VERCEL_ORG_ID override them.
//
// Exit 0 = the live address serves the previous version within the target
// (config/recovery.ts); 1 = anything else. --dry-run names both versions and
// changes nothing.

// First: lets this script load lib/ modules marked `import "server-only"` (issue 797).
import "./server-only-node.cjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rollback } from "../lib/rollback";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function projectIdentity(): { projectId: string; teamId?: string } {
  const file = existsSync(".vercel/project.json")
    ? (JSON.parse(readFileSync(".vercel/project.json", "utf8")) as { projectId?: string; orgId?: string })
    : {};
  return {
    projectId: process.env.VERCEL_PROJECT_ID || file.projectId || "",
    teamId: process.env.VERCEL_ORG_ID || file.orgId || undefined,
  };
}

async function main(): Promise<void> {
  const token = process.env.VERCEL_TOKEN ?? "";
  const appUrl = process.env.APP_URL ?? "";
  const { projectId, teamId } = projectIdentity();
  const missing = [!token && "VERCEL_TOKEN", !appUrl && "APP_URL", !projectId && "the project id (.vercel/project.json)"].filter(Boolean);
  if (missing.length) {
    console.error(`[rollback] missing: ${missing.join(", ")}`);
    process.exit(2);
  }
  const report = await rollback({
    token,
    projectId,
    teamId,
    appUrl,
    toDeploymentId: arg("--to"),
    dryRun: process.argv.includes("--dry-run"),
  });
  const out = arg("--report");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  const name = (d: typeof report.from) => (d ? `${d.id} (${d.commit?.slice(0, 7) ?? "no commit"})` : "none");
  console.log(`[rollback] from ${name(report.from)} to ${name(report.to)}${report.dry_run ? " — dry run, nothing changed" : ""}`);
  if (report.seconds !== null) {
    console.log(`[rollback] the live address served the previous version after ${report.seconds}s (target ${report.target_seconds}s, aim ${report.aim_seconds}s)`);
  }
  for (const p of report.problems) console.error(`[rollback] problem: ${p}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[rollback] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
