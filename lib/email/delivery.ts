// Delivery monitoring (app-business-core issue 757). Matt Murphy #131, word for
// word: "delivery monitoring that tells you where your emails actually land" and
// "you need to know your inbox placement rate and your spam complaint rate
// before your customers tell you about it".
//
// The provider reports what happened to each message (delivered, bounced,
// marked as spam); app/api/email/events/route.ts records each report here, with
// no address, subject or body. Over the last 30 days:
//
//   bounce rate     bounced / sent        red at 4% or more, once 50 have gone
//                                         (one mistyped address in five sends is
//                                         not a reputation problem);
//   complaint rate  complained / delivered red at 0.1% or more — Gmail asks
//                                         senders to stay under 0.1% and never
//                                         reach 0.3%; at launch volumes that is
//                                         any complaint at all.
//
// /api/health's `email` check turns red (503) on either, and on a live app whose
// monitoring is not set up, so the outside uptime check raises the alert before
// a customer does. Inbox placement — inbox or spam folder at Gmail and Outlook —
// is not in any provider report: Google Postmaster Tools and Microsoft SNDS show
// it for the sending domain (docs/email.md).

import "server-only";

import { and, gte, sql } from "drizzle-orm";
import { emailEvents } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";

export type DeliveryEventType =
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced"
  | "complained"
  | "failed"
  | "suppressed"
  | "other";

export interface DeliveryEvent {
  id: string;
  type: DeliveryEventType;
  messageId: string | null;
  bounceKind: "permanent" | "transient" | null;
}

export const WINDOW_DAYS = 30;
export const BOUNCE_RATE_LIMIT = 0.04;
export const BOUNCE_MIN_SENT = 50;
export const COMPLAINT_RATE_LIMIT = 0.001;

const TYPES: Record<string, DeliveryEventType> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};

/**
 * One provider report, reduced to what is kept. `eventId` is the report's own
 * id (the webhook-id header). Returns null for a body that is not a report.
 */
export function normaliseEvent(eventId: string, body: unknown): DeliveryEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { type?: unknown; data?: { email_id?: unknown; bounce?: { type?: unknown } } };
  if (typeof b.type !== "string") return null;
  const type = TYPES[b.type] ?? "other";
  const messageId = typeof b.data?.email_id === "string" ? b.data.email_id : null;
  let bounceKind: DeliveryEvent["bounceKind"] = null;
  if (type === "bounced") {
    const kind = String(b.data?.bounce?.type ?? "").toLowerCase();
    bounceKind = kind === "permanent" ? "permanent" : "transient";
  }
  return { id: eventId, type, messageId, bounceKind };
}

/** Keep one report. A repeated report (same id) is counted once. */
export async function recordDeliveryEvent(db: AppDatabase, event: DeliveryEvent): Promise<void> {
  await db
    .insert(emailEvents)
    .values({ id: event.id, type: event.type, messageId: event.messageId, bounceKind: event.bounceKind })
    .onConflictDoNothing({ target: emailEvents.id })
    .run();
}

export interface DeliveryStats {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  bounceRate: number | null;
  complaintRate: number | null;
}

/** Counts and rates since `sinceMs`. */
export async function deliveryStats(db: AppDatabase, sinceMs: number): Promise<DeliveryStats> {
  const rows = await db
    .select({ type: emailEvents.type, n: sql<number>`count(*)` })
    .from(emailEvents)
    .where(and(gte(emailEvents.receivedAt, new Date(sinceMs))))
    .groupBy(emailEvents.type)
    .all();
  const count = (t: DeliveryEventType) => Number(rows.find((r) => r.type === t)?.n ?? 0);
  const sent = count("sent");
  const delivered = count("delivered");
  const bounced = count("bounced");
  const complained = count("complained");
  return {
    sent,
    delivered,
    bounced,
    complained,
    bounceRate: sent > 0 ? bounced / sent : null,
    complaintRate: delivered > 0 ? complained / delivered : complained > 0 ? 1 : null,
  };
}

export interface EmailHealth {
  ok: boolean;
  detail: string;
}

/** The verdict /api/health reports, from the setup and the 30-day stats. */
export function judgeDelivery(
  setup: { domainOk: boolean; domainDetail: string; monitoringOn: boolean },
  stats: DeliveryStats | null,
): EmailHealth {
  if (!setup.domainOk) return { ok: false, detail: setup.domainDetail };
  if (!setup.monitoringOn) return { ok: false, detail: "delivery reports are not set up (EMAIL_EVENTS_SECRET)" };
  if (!stats) return { ok: true, detail: "delivery counts could not be read" };
  if (stats.complaintRate !== null && stats.complaintRate >= COMPLAINT_RATE_LIMIT) {
    return { ok: false, detail: "spam complaint rate at or over 0.1% in 30 days" };
  }
  if (stats.sent >= BOUNCE_MIN_SENT && stats.bounceRate !== null && stats.bounceRate >= BOUNCE_RATE_LIMIT) {
    return { ok: false, detail: "bounce rate at or over 4% in 30 days" };
  }
  return { ok: true, detail: "delivery within limits over 30 days" };
}
