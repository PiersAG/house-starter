// POST /api/error-report — where the app's own pages send browser errors, to be
// passed on to Sentry (app-business-core issue 761; decision 700).
//
// The page never talks to Sentry itself: components/ErrorReporter.tsx posts
// here, and the server scrubs the report and sends it on
// (lib/observability/sentry.ts reportBrowserError). So the page policy
// (lib/csp.ts) never names an outside address, personal data is stripped in
// one place the browser cannot skip, the day's budget covers browser errors
// too, and the signed-in account's opaque id is attached from the session —
// the account count Sentry shows for an issue includes browser errors.
//
// OFF (config/error-tracking.ts switched off, or no EU SENTRY_DSN): 404 before
// the body is read — the route is absent to the app's own pages. A request
// from another website is refused 403 first, in both states, like every other
// write endpoint (tests/e2e/csrf.spec.ts), so it learns nothing of the switch.
//
// ON, it is bounded: same-origin requests only (lib/csrf.ts verifySameOrigin),
// 16 KB per body, one report per body in a fixed shape (anything else is
// dropped), and its own route limit (config/rate-limits.ts public.error-report).
// It answers 204 and never says whether the report was sent on.
//
// Verified via E2E (app/api/** is excluded from unit coverage); the route is
// called directly in tests/unit/error-tracking-both-states.test.ts.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { verifySameOrigin } from "@/lib/csrf";
import { errorTrackingTarget } from "@/lib/observability/sentry-dsn";
import { reportBrowserError } from "@/lib/observability/sentry";
import { withRequestLog } from "@/lib/observability/with-request-log";

import { withRouteLimit } from "@/lib/abuse/route-limit";
export const runtime = "nodejs";

const ERROR_REPORT_MAX_BYTES = 16_384;

const reportSchema = z
  .object({
    type: z.string().max(100),
    message: z.string().max(2000),
    stack: z.string().max(8000).nullish(),
    page: z.string().max(500),
    kind: z.enum(["error", "unhandledrejection", "boundary", "rage_click"]),
  })
  .strict();

const NO_CONTENT = () => new Response(null, { status: 204 });

async function handlePOST(request: Request): Promise<Response> {
  // Another website is refused first, in both states (so it cannot tell which).
  const foreign = verifySameOrigin(request);
  if (foreign) return foreign;
  if (!errorTrackingTarget()) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > ERROR_REPORT_MAX_BYTES) return NO_CONTENT();
  const raw = await request.text();
  if (raw.length > ERROR_REPORT_MAX_BYTES) return NO_CONTENT();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NO_CONTENT();
  }
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) return NO_CONTENT();

  let userId: string | null = null;
  try {
    userId = (await auth())?.user?.id ?? null;
  } catch {
    userId = null;
  }
  reportBrowserError({ ...parsed.data, userId, userAgent: request.headers.get("user-agent") });
  return NO_CONTENT();
}

// One structured log line per request, with its id (issue 503).
export const POST = withRequestLog("/api/error-report", withRouteLimit("public.error-report", handlePOST));
