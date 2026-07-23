// Real database liveness probe for /api/health. Reuses the observability sink's
// cached connection (one DATABASE_URL client per process) so the health
// endpoint does not open its own connection on every hit. Never throws — a
// connection/query failure returns { ok: false }, which assembleHealth turns
// into a degraded (503) report.

import { sinkClient } from "@/lib/observability/error-log";

export async function pingDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; detail?: string }> {
  const client = sinkClient(env);
  if (!client) return { ok: true, detail: "no DATABASE_URL configured (skipped)" };
  try {
    await client.execute("SELECT 1");
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
