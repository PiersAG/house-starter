// GET /api/cron/retention — the daily retention job (app-business-core issues
// 722, 791, 352; Matt Murphy step 156: "after 30 days hard delete automatically no
// manual cleanup"). Called once a day by Vercel's scheduler (vercel.json
// `crons`), which sends `Authorization: Bearer <CRON_SECRET>`. Erases accounts
// whose 30 days are up, deletes expired retained records and rows past their
// age limit (lib/privacy/retention-job.ts). Then sends the dispute-deadline
// reminders (issue 370, lib/disputes/reminders.ts: one a day to the owner in the last 3
// days before a dispute's evidence deadline, with the evidence pack), when the app
// sells a subscription.
//
// Refused without the right secret (401), and when CRON_SECRET is not set
// (503): the job then does not run, and /api/health's `deletions` check turns
// red once any erasure is 72 hours late, so a missing key is seen, not silent.
// Part of the account kernel (`auth`): absent (404) when it is off.

import { NextResponse } from "next/server";
import { isKernelEnabled } from "@/config/kernel";
import { catalogDb } from "@/lib/catalog";
import { withRequestLog } from "@/lib/observability/with-request-log";
import { withRouteLimit } from "@/lib/abuse/route-limit";
import { cronAuthorised } from "@/lib/privacy/cron-auth";
import { runRetentionJob } from "@/lib/privacy/retention-job";
import { liveTenantPlane, sendErasureConfirmation } from "@/lib/privacy/runtime";
import { readSecret } from "@/lib/secrets";
import { runDisputeReminders } from "@/lib/disputes/reminders";
import { isSubscriptionBillingActive } from "@/lib/billing/routes";
import { sendEmail } from "@/lib/email/send";
import { getAppName } from "@/lib/branding";
import { canonicalBaseUrl } from "@/lib/app-url";
import { recordError } from "@/lib/observability/error-log";

export const runtime = "nodejs";

async function handleGET(request: Request): Promise<Response> {
  if (!isKernelEnabled("auth")) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const secret = readSecret("CRON_SECRET");
  if (!secret) {
    return NextResponse.json({ error: "The retention job is not configured." }, { status: 503 });
  }
  if (!cronAuthorised(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }
  const run = await runRetentionJob(catalogDb, {
    tenantPlane: liveTenantPlane,
    confirm: sendErasureConfirmation,
  });
  const disputes = await runDisputeReminders(catalogDb, {
    now: new Date(),
    enabled: isSubscriptionBillingActive(),
    ownerEmail: process.env.OWNER_EMAIL?.trim() || null,
    appName: await getAppName(),
    baseUrl: reminderBaseUrl(request),
    send: sendEmail,
    report: async (message, context) => {
      await recordError({ message: `billing: ${message}`, route: "/api/cron/retention", method: "GET", context });
    },
  });
  return NextResponse.json(
    {
      disputeReminders: disputes.sent,
      erased: run.erased.length,
      unverified: run.erased.filter((r) => !r.verified).length,
      expiredRetained: run.expiredRetained,
      purgedTables: Object.keys(run.purged).length,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** The app's address for links in the reminder (the configured one, else this request's). */
function reminderBaseUrl(request: Request): string {
  try {
    return canonicalBaseUrl(undefined, new URL(request.url).origin);
  } catch {
    return new URL(request.url).origin;
  }
}

export const GET = withRequestLog("/api/cron/retention", withRouteLimit("jobs.retention", handleGET));
