// POST /api/email/events — the email provider's delivery reports
// (app-business-core issue 757: "delivery monitoring that tells you where your
// emails actually land").
//
// The provider calls it for each message it sends, delivers, bounces or sees
// marked as spam. Each report is signature-checked (lib/email/webhook-signature.ts)
// and kept without its address, subject or body (lib/email/delivery.ts); the
// 30-day bounce and complaint rates feed /api/health's `email` check.
//
// Absent (404) unless the app sends real mail (EMAIL_SEND_MODE=live) AND
// EMAIL_EVENTS_SECRET is set: an app that sends nothing has no reports to take,
// and an unsigned endpoint is never open. A live app without the secret shows a
// red `email` health check instead. Part of the account kernel (`auth`): absent
// when that is off.

import { NextResponse } from "next/server";
import { isKernelEnabled } from "@/config/kernel";
import { catalogDb } from "@/lib/catalog";
import { normaliseEvent, recordDeliveryEvent } from "@/lib/email/delivery";
import { getEmailSendMode } from "@/lib/email/send";
import { signedHeaders, verifySignature } from "@/lib/email/webhook-signature";
import { withRequestLog } from "@/lib/observability/with-request-log";
import { withRouteLimit } from "@/lib/abuse/route-limit";
import { readSecret } from "@/lib/secrets";

export const runtime = "nodejs";

/** Reports are small; anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

function notFound(): Response {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

async function handlePOST(request: Request): Promise<Response> {
  if (!isKernelEnabled("auth")) return notFound();
  if (getEmailSendMode() !== "live") return notFound();
  const secret = readSecret("EMAIL_EVENTS_SECRET");
  if (!secret) return notFound();

  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }
  const headers = signedHeaders(request.headers);
  const verdict = verifySignature(secret, headers, body, Math.floor(Date.now() / 1000));
  if (!verdict.ok) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Not a report." }, { status: 400 });
  }
  const event = normaliseEvent(headers.id as string, parsed);
  if (!event) return NextResponse.json({ error: "Not a report." }, { status: 400 });

  await recordDeliveryEvent(catalogDb, event);
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

export const POST = withRequestLog("/api/email/events", withRouteLimit("email.events", handlePOST));
