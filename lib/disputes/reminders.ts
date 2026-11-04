// The dispute-deadline reminder (PiersAG/app-business-core#370: "notify CEO with a
// deadline timer"). Run once a day by the daily job (app/api/cron/retention).
//
// Every open dispute that still needs a response and whose evidence deadline is
// within REMINDER_DAYS gets one email a day to the app's owner, with the days left
// and the evidence pack (lib/disputes/evidence.ts) already filled in. "Still needs a
// response" is Stripe's own status, recorded by the webhook: once the owner sends
// evidence (under_review) or accepts (lost), or the bank decides, the reminders stop.
// One a day for the last three days, rather than one at a fixed point, so a missed
// daily run still leaves a reminder before the deadline, and needs no record of
// what was sent.
//
// Part of subscription billing (kernel `subscription_billing`, and only for an app
// that sells a subscription): with either off, nothing runs and nothing is sent.

import "server-only";

import { and, inArray, isNotNull, lte, gt } from "drizzle-orm";
import type { AppDatabase } from "@/lib/users";
import { billingDisputes } from "@/lib/schema";
import { assembleEvidence, renderEvidence } from "@/lib/disputes/evidence";
import { disputeReminderTemplate } from "@/lib/email/templates/disputes";
import type { EmailTemplate } from "@/lib/email/send";

/** Remind on each of the last this-many days before the deadline. */
export const REMINDER_DAYS = 3;

/** Stripe's statuses for a dispute that still waits for the owner. */
export const NEEDS_RESPONSE = ["needs_response", "warning_needs_response"] as const;

export interface ReminderDeps {
  now: Date;
  enabled: boolean;
  ownerEmail: string | null;
  appName: string;
  baseUrl: string;
  send: <T>(to: string, template: EmailTemplate<T>, data: T) => Promise<unknown>;
  report?: (message: string, context: Record<string, unknown>) => Promise<void>;
}

export interface ReminderRun {
  due: number;
  sent: number;
  skipped: "off" | "no-owner" | null;
}

export async function runDisputeReminders(db: AppDatabase, deps: ReminderDeps): Promise<ReminderRun> {
  if (!deps.enabled) return { due: 0, sent: 0, skipped: "off" };
  const horizon = new Date(deps.now.getTime() + REMINDER_DAYS * 86_400_000);
  const due = await db
    .select()
    .from(billingDisputes)
    .where(
      and(
        inArray(billingDisputes.status, [...NEEDS_RESPONSE]),
        isNotNull(billingDisputes.evidenceDueBy),
        gt(billingDisputes.evidenceDueBy, deps.now),
        lte(billingDisputes.evidenceDueBy, horizon),
      ),
    )
    .all();
  if (due.length === 0) return { due: 0, sent: 0, skipped: null };
  if (!deps.ownerEmail) {
    await deps.report?.("a dispute deadline is near and no owner email is set to remind", { disputes: due.length });
    return { due: due.length, sent: 0, skipped: "no-owner" };
  }
  let sent = 0;
  for (const d of due) {
    const pack = await assembleEvidence(db, d.stripeDisputeId, { appName: deps.appName, baseUrl: deps.baseUrl });
    if (!pack || !d.evidenceDueBy) continue;
    const daysLeft = Math.max(1, Math.ceil((d.evidenceDueBy.getTime() - deps.now.getTime()) / 86_400_000));
    await deps.send(deps.ownerEmail, disputeReminderTemplate, {
      appName: deps.appName,
      disputeId: d.stripeDisputeId,
      amount: pack.amount,
      evidenceDueBy: d.evidenceDueBy,
      daysLeft,
      evidence: renderEvidence(pack),
    });
    sent += 1;
  }
  return { due: due.length, sent, skipped: null };
}
