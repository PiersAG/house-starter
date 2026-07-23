// Health-report assembler (la-a-uptime-monitoring §a).
//
// Pure and dependency-injected so it is unit-tested without a real database or
// clock. The route (app/api/health/route.ts) wires the real DB ping + error
// count; tests pass stubs. This deliberately produces a DEEP readiness report —
// a real DB round-trip and an error-rate signal — not a bare 200, because a
// bare 200 (or an SSO 302 accepted as "up") is exactly the false-green that hid
// a live 500 across the capability retrofit.

export type HealthStatus = "ok" | "degraded";

export interface HealthCheck {
  name: string;
  ok: boolean;
  /** A failing critical check drives status → degraded (HTTP 503). */
  critical: boolean;
  detail?: string;
}

export interface HealthReport {
  status: HealthStatus;
  checks: HealthCheck[];
  lifecycle_state: string | null;
  commit: string | null;
  /** Errors persisted in the last hour; null when the count could not be read. */
  recent_errors_1h: number | null;
  time: string;
}

export interface HealthDeps {
  pingDb: () => Promise<{ ok: boolean; detail?: string }>;
  errorCountSince: (sinceEpochMs: number) => Promise<number>;
  now: () => number;
  env: NodeJS.ProcessEnv;
}

export async function assembleHealth(deps: HealthDeps): Promise<HealthReport> {
  const nowMs = deps.now();
  const checks: HealthCheck[] = [];

  // Database connectivity — critical. A throw is treated as not-ok, never
  // propagated (the endpoint must always answer, with a status).
  let db: { ok: boolean; detail?: string };
  try {
    db = await deps.pingDb();
  } catch (e) {
    db = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  checks.push({ name: "database", ok: db.ok, critical: true, detail: db.detail });

  // Recent error rate — informational only. Its failure must not flip a
  // DB-healthy app to degraded, so a throw becomes null, not a failed check.
  let recentErrors: number | null = null;
  try {
    recentErrors = await deps.errorCountSince(nowMs - 3_600_000);
  } catch {
    recentErrors = null;
  }

  const status: HealthStatus = checks.every((c) => !c.critical || c.ok)
    ? "ok"
    : "degraded";

  return {
    status,
    checks,
    lifecycle_state: deps.env.APP_LIFECYCLE_STATE ?? null,
    commit: deps.env.VERCEL_GIT_COMMIT_SHA ?? deps.env.GIT_COMMIT_SHA ?? null,
    recent_errors_1h: recentErrors,
    time: new Date(nowMs).toISOString(),
  };
}
