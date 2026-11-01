// POST /api/csp-report — where browsers send Content-Security-Policy
// violations (app-business-core issue 446, Matt Murphy item 165).
//
// Named by every policy lib/csp.ts writes (`report-uri` and `report-to`). Each
// violation becomes one `csp_violation` line on the platform log with the
// directive, the blocked origin, the page path and whether the policy was
// enforced or report-only — what is needed to decide whether a report-only
// source in config/csp.ts can be enforced. Nothing else from the report is kept.
//
// Unauthenticated by design (a browser sends it, often without cookies), so it
// is bounded: 16 KB per body, 10 violations per body, 60 reports a minute per
// client address. It always answers 204 and never says why, so it tells a
// caller nothing.
//
// Verified via E2E (app/api/** is excluded from unit coverage); the parser is
// unit-tested in tests/unit/csp-report.test.ts.

import { z } from "zod";
import { CSP_REPORT_MAX_BYTES, parseCspReport } from "@/lib/csp-report";
import { clientKeyFromHeaders, getRateLimiter } from "@/lib/rate-limit";
import { logSecurityEvent } from "@/lib/security-log";

export const runtime = "nodejs";

const reportSchema = z.union([
  z.array(z.unknown()),
  z.object({ "csp-report": z.record(z.string(), z.unknown()) }),
]);

const NO_CONTENT = () => new Response(null, { status: 204 });

async function underLimit(headers: Headers): Promise<boolean> {
  try {
    const result = await getRateLimiter().hit(`csp-report:${clientKeyFromHeaders(headers)}`, {
      limit: 60,
      windowSeconds: 60,
    });
    return result.allowed;
  } catch {
    // No rate-limit store: drop the report rather than log without a bound.
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > CSP_REPORT_MAX_BYTES) return NO_CONTENT();
  if (!(await underLimit(request.headers))) return NO_CONTENT();

  const raw = await request.text();
  if (raw.length > CSP_REPORT_MAX_BYTES) return NO_CONTENT();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NO_CONTENT();
  }
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) return NO_CONTENT();

  for (const v of parseCspReport(parsed.data)) {
    logSecurityEvent("csp_violation", {
      directive: v.directive,
      blocked: v.blocked,
      page: v.page,
      disposition: v.disposition,
    });
  }
  return NO_CONTENT();
}
