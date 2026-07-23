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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = await assembleHealth({
    pingDb: () => pingDatabase(),
    errorCountSince: (ms) => errorCountSince(ms),
    now: () => Date.now(),
    env: process.env,
  });

  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
