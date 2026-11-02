// GET /api/cron/retention — the daily retention job (app-business-core issues
// 722, 791, 352; Matt Murphy step 156: "after 30 days hard delete automatically no
// manual cleanup"). Called once a day by Vercel's scheduler (vercel.json
// `crons`), which sends `Authorization: Bearer <CRON_SECRET>`. Erases accounts
// whose 30 days are up, deletes expired retained records and rows past their
// age limit (lib/privacy/retention-job.ts).
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
  return NextResponse.json(
    {
      erased: run.erased.length,
      unverified: run.erased.filter((r) => !r.verified).length,
      expiredRetained: run.expiredRetained,
      purgedTables: Object.keys(run.purged).length,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = withRequestLog("/api/cron/retention", withRouteLimit("jobs.retention", handleGET));
