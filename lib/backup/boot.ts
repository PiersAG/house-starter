// Start the built app on a restored copy and check it serves (app-business-core
// issue 752; Matt Murphy #88: "verify the data is intact and the application
// runs"). Used by the restore drill. Needs `npm run build` first.
//
// The drill environment is a throwaway: drill-only values (no real key, email
// logged not sent, no payment reaches Stripe), a local port, the restored files.

import "server-only";

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { RestoreResult } from "@/lib/backup/restore";

/** The only values the drilled app takes from the drill's own environment: what a
 *  program needs to run at all (where programs and the home folder are, the temp
 *  folder, language and time zone). Everything else is left behind: no cloud key
 *  (AWS_*), no GitHub sign-in value (GITHUB_TOKEN, ACTIONS_*), no database token
 *  reaches the app (app-business-core #528 review, finding 2). An allow-list, never
 *  a copy of `process.env`, so a value added to the job later cannot leak in. */
export const DRILL_ENV_PASSTHROUGH = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"] as const;

/** Drill-only values: never a real key; the drill reaches no outside service. */
export function drillEnv(
  restored: RestoreResult,
  port: number,
  from: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const drillOnly = "restore-drill-only-not-a-real-value";
  const passed: Record<string, string | undefined> = {};
  for (const k of DRILL_ENV_PASSTHROUGH) {
    if (from[k] !== undefined) passed[k] = from[k];
  }
  return {
    ...passed,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    PORT: String(port),
    CATALOG_DATABASE_URL: restored.catalogUrl,
    DATABASE_URL: restored.catalogUrl,
    TENANCY_MODE: restored.manifest.tenancy,
    AUTH_SECRET: drillOnly,
    RATE_LIMIT_ALLOW_IN_MEMORY: "true",
    STRIPE_SECRET_KEY: `sk_test_${drillOnly}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${drillOnly}`,
    EMAIL_PROVIDER_API_KEY: `re_${drillOnly}`,
    EMAIL_SEND_MODE: "log",
    APP_LIFECYCLE_STATE: from.APP_LIFECYCLE_STATE || "LAUNCHED",
    MFA_ENCRYPTION_KEY: Buffer.from("restore-drill-only-key-32-bytes!").toString("base64"),
  };
}

/** Build the app with the drill-only values, when no build exists yet. */
export function buildForDrill(): { ok: boolean; detail?: string } {
  const r = spawnSync("npx", ["next", "build"], {
    env: drillEnv({ catalogUrl: "file:drill-build.db", manifest: { tenancy: "per_tenant" } } as RestoreResult, 0),
    stdio: ["ignore", "inherit", "inherit"],
  });
  return r.status === 0 ? { ok: true } : { ok: false, detail: `the app did not build (exit code ${r.status})` };
}

export async function bootAndCheck(restored: RestoreResult, port: number, timeoutMs = 120_000): Promise<{ ok: boolean; detail?: string }> {
  // Its own process group (detached), so stopping it stops the server npx starts
  // too: killing npx alone leaves next-server running, holding the caller's output
  // open — the drill then hangs until its job's time limit.
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    env: drillEnv(restored, port),
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  // Fail fast, never hang: an app that exits (no build, a refused setting) is a
  // failed start now, not after the whole wait.
  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? 1;
  });
  try {
    while (Date.now() < deadline) {
      if (exited !== null) return { ok: false, detail: `the app stopped at start (exit code ${exited})` };
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" });
        const body = (await r.json()) as { status?: string; checks?: { name: string; ok: boolean }[] };
        if (r.status === 200 && body.status === "ok") return { ok: true };
        last = `HTTP ${r.status}, failing checks: ${(body.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join(", ") || "none"}`;
        if (r.status === 503) return { ok: false, detail: last };
      } catch {
        // not listening yet
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    return { ok: false, detail: `the app did not answer within ${Math.round(timeoutMs / 1000)} seconds (${last})` };
  } finally {
    await stopGroup(child);
  }
}

/** Stop a detached child and everything it started; wait until it has gone. */
async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((res) => child.once("exit", () => res()));
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      // the group has already gone
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 10_000);
  await gone;
  clearTimeout(timer);
  signal("SIGKILL"); // anything in the group that outlived its parent
}

/** The step that replays the deletion record on the restored catalog before the app
 *  reopens (docs/recovery.md § D). It runs the app's own scripts/erasure-ledger.ts with
 *  the same allow-listed drill values as the app itself (drillEnv), never a copy of the
 *  job's `process.env` (app-business-core #528 second review, finding 9). */
export function ledgerReplayStep(
  ledger: string,
  port: number,
  run: typeof spawnSync = spawnSync,
  from: Record<string, string | undefined> = process.env,
): { name: string; run: (restored: RestoreResult) => Promise<void> } {
  return {
    name: "replay the deletion record on the restored catalog",
    run: async (restored) => {
      const r = run("npx", ["tsx", "scripts/erasure-ledger.ts", "replay", ledger], {
        env: drillEnv(restored, port, from),
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (r.status !== 0) throw new Error(`the deletion record did not replay (exit code ${r.status})`);
    },
  };
}
