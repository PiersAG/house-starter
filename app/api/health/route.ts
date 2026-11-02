// GET /api/health — deep readiness endpoint (la-a-uptime-monitoring §a).
//
// A CORE route: it is not a capability (no flag) and not under a protected
// /dashboard prefix, so the edge middleware leaves it untouched — reachable
// with every capability OFF and without a session. That exemption is pinned by
// tests/unit/health-route-exempt.test.ts so a future middleware change can't
// silently start 404'ing or redirecting it.
//
// It returns a DEEP report (a real DB round-trip + error-rate signal), not a
// bare 200, and 503 when a critical check fails — so the external prober's
// green means the app genuinely serves, not that an SSO/redirect answered.
//
// Verified via E2E (app/api/** is excluded from unit coverage); the pure
// assembler is unit-tested directly in tests/unit/health.test.ts.

import { assembleHealth } from "@/lib/health/checks";
import { pingDatabase } from "@/lib/health/db-ping";
import { errorCountSince } from "@/lib/observability/error-log";
import { slowRequestCountSince, slowRequestMs } from "@/lib/observability/log";
import { withRequestLog } from "@/lib/observability/with-request-log";
import { crossTenantCountSince } from "@/lib/tenant/access-log";
import { getTenancyMode } from "@/lib/db";
import { z } from "zod";
import { defineDto } from "@/lib/dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The fields the external prober reads, named (issue 763). `detail` is a fixed
// reason, never the database's own error text (issue 444).
// slow_requests_1h: requests slower than SLOW_REQUEST_MS (issue 503).
// tenant_isolation check: a cross-tenant access in 24h fails it (issue 806).
const HealthResponse = defineDto({
  status: z.enum(["ok", "degraded"]),
  checks: z.array(
    z.object({ name: z.string(), ok: z.boolean(), critical: z.boolean(), detail: z.string().optional() }),
  ),
  lifecycle_state: z.string().nullable(),
  commit: z.string().nullable(),
  recent_errors_1h: z.number().nullable(),
  slow_requests_1h: z.number().nullable(),
  time: z.string(),
});

export const GET = withRequestLog("/api/health", async (): Promise<Response> => {
  const report = await assembleHealth({
    pingDb: () => pingDatabase(),
    errorCountSince: (ms) => errorCountSince(ms),
    slowRequestCountSince: (ms) => slowRequestCountSince(ms, slowRequestMs()),
    // Shared tenancy has one database for everyone: no per-tenant access to watch.
    crossTenantCountSince:
      getTenancyMode() === "shared" ? undefined : (ms) => crossTenantCountSince(ms),
    now: () => Date.now(),
    env: process.env,
  });

  return Response.json(HealthResponse.from(report), {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
});
