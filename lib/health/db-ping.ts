// Real database liveness probe for /api/health. Reuses the observability sink's
// cached connection (one DATABASE_URL client per process) so the health
// endpoint does not open its own connection on every hit. Never throws — a
// connection/query failure returns { ok: false }, which assembleHealth turns
// into a degraded (503) report.
//
// The answer is public (no session), so a failure carries a FIXED reason; the
// driver's own text (hosts, auth failures) goes to the server log only (issue
// 444, ASVS V7.4.1). The external prober reads the status, never this text.

import "server-only";

import { sinkClient } from "@/lib/observability/error-log";

/** The one public reason a database check fails (issue 444). */
export const DB_UNREACHABLE = "database unreachable";

export async function pingDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    // Opening the connection can fail too (a bad URL or path): same fixed answer.
    const client = sinkClient(env);
    if (!client) return { ok: true, detail: "no DATABASE_URL configured (skipped)" };
    await client.execute("SELECT 1");
    return { ok: true };
  } catch (e) {
    console.error("[health] database ping failed", e instanceof Error ? e.message : e);
    return { ok: false, detail: DB_UNREACHABLE };
  }
}
