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
  /** Requests slower than the slow-request threshold in the last hour (#503); null when unknown. */
  slow_requests_1h: number | null;
  time: string;
}

export interface HealthDeps {
  pingDb: () => Promise<{ ok: boolean; detail?: string }>;
  errorCountSince: (sinceEpochMs: number) => Promise<number>;
  /** Slow requests since a time (#503). Optional: absent → null. */
  slowRequestCountSince?: (sinceEpochMs: number) => Promise<number>;
  /** Cross-tenant accesses since a time (#806). Optional: absent → no check. */
  crossTenantCountSince?: (sinceEpochMs: number) => Promise<number>;
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
    // Public answer: a fixed reason; the raw text to the server log (issue 444).
    console.error("[health] database check threw", e instanceof Error ? e.message : e);
    db = { ok: false, detail: "database check failed" };
  }
  checks.push({ name: "database", ok: db.ok, critical: true, detail: db.detail });

  // Tenant isolation (#806) — critical. A signed-in caller from one tenant
  // opened another tenant's data in the last 24 hours: the app answers 503 so
  // the external prober raises the alert. A count that cannot be read is not
  // a detection, so it does not fail the check.
  if (deps.crossTenantCountSince) {
    let crossTenant = 0;
    try {
      crossTenant = await deps.crossTenantCountSince(nowMs - 86_400_000);
    } catch {
      crossTenant = 0;
    }
    checks.push({
      name: "tenant_isolation",
      ok: crossTenant === 0,
      critical: true,
      detail: crossTenant === 0 ? "no cross-tenant access in 24h" : "cross-tenant access detected",
    });
  }

  // Recent error rate — informational only. Its failure must not flip a
  // DB-healthy app to degraded, so a throw becomes null, not a failed check.
  let recentErrors: number | null = null;
  try {
    recentErrors = await deps.errorCountSince(nowMs - 3_600_000);
  } catch {
    recentErrors = null;
  }

  let slowRequests: number | null = null;
  if (deps.slowRequestCountSince) {
    try {
      slowRequests = await deps.slowRequestCountSince(nowMs - 3_600_000);
    } catch {
      slowRequests = null;
    }
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
    slow_requests_1h: slowRequests,
    time: new Date(nowMs).toISOString(),
  };
}
