// Start the built app on a restored copy and check it serves (app-business-core
// issue 752; Matt Murphy #88: "verify the data is intact and the application
// runs"). Used by the restore drill. Needs `npm run build` first.
//
// The drill environment is a throwaway: drill-only values (no real key, email
// logged not sent, no payment reaches Stripe), a local port, the restored files.

import "server-only";

import { spawn, spawnSync } from "node:child_process";
import type { RestoreResult } from "@/lib/backup/restore";

/** Drill-only values: never a real key; the drill reaches no outside service. */
export function drillEnv(restored: RestoreResult, port: number): NodeJS.ProcessEnv {
  const drillOnly = "restore-drill-only-not-a-real-value";
  return {
    ...process.env,
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
    APP_LIFECYCLE_STATE: process.env.APP_LIFECYCLE_STATE || "LAUNCHED",
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
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    env: drillEnv(restored, port),
    stdio: ["ignore", "inherit", "inherit"],
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
    child.kill("SIGTERM");
  }
}

