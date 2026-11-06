// The dispute evidence pack, assembled automatically (PiersAG/app-business-core#370;
// Matt Murphy #138: "build a response template for you with transaction logs
// delivery confirmations a refund policy with screenshots preloaded").
//
// Everything Stripe's dispute form asks for that the app itself knows, gathered from
// the app's own records for the disputed customer and laid out under the names of
// Stripe's evidence fields, so the owner copies each into the form (or attaches the
// text) instead of collecting it by hand:
//
//   customer_email_address, customer_name   — the account (users)
//   product_description                     — what the app sells
//   service_date                            — when the account started
//   receipt / transaction log               — every invoice the app was told about,
//                                             paid or failed, with the receipt it sent
//   refund_policy, refund_policy_disclosure — the policy text, and that the payment
//                                             page linked it above the pay button
//   access_activity_log                     — proof of use: the account's recorded
//                                             activity (audit trail)
//
// "Screenshots preloaded": the refund policy is given as its exact text and its
// public address (/refund-policy), which Stripe accepts as the policy itself; a
// screenshot of the payment page is the one item the owner adds by hand (runbook
// docs/billing-disputes.md). Nothing here is sent anywhere: the pack goes to the
// owner (the deadline reminder, scripts/dispute-evidence.ts), who decides to send
// evidence or accept. Read-only over the app's own tables.

import "server-only";

import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/lib/users";
import { auditEvents, billingDisputes, billingInvoices, subscriptions, users } from "@/lib/schema";
import { refundPolicy, refundPolicyParagraphs } from "@/config/refund-policy";
import { formatDay, formatMoney } from "@/lib/email/templates/billing";

export interface EvidencePack {
  disputeId: string;
  amount: string;
  reason: string;
  status: string;
  evidenceDueBy: Date | null;
  /** Stripe's evidence field name → the text for it. */
  fields: Record<string, string>;
  /** What the owner still adds by hand. */
  byHand: string[];
}

const MAX_LINES = 50;

/** The pack for one dispute, or null when the app has no record of it. */
export async function assembleEvidence(
  db: AppDatabase,
  disputeId: string,
  opts: { appName: string; baseUrl: string },
): Promise<EvidencePack | null> {
  const [d] = await db.select().from(billingDisputes).where(eq(billingDisputes.stripeDisputeId, disputeId)).all();
  if (!d) return null;
  const sub = d.stripeCustomerId
    ? (await db.select().from(subscriptions).where(eq(subscriptions.stripeCustomerId, d.stripeCustomerId)).all())[0]
    : undefined;
  const user = sub ? (await db.select().from(users).where(eq(users.id, sub.userId)).all())[0] : undefined;
  const invoices = d.stripeCustomerId
    ? await db
        .select()
        .from(billingInvoices)
        .where(eq(billingInvoices.stripeCustomerId, d.stripeCustomerId))
        .orderBy(desc(billingInvoices.updatedAt))
        .all()
    : [];
  const activity = user
    ? await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.subjectUserId, user.id))
        .orderBy(desc(auditEvents.occurredAt))
        .limit(MAX_LINES)
        .all()
    : [];

  const money = (n: number | null, c: string | null) => (n !== null && c ? formatMoney(n, c) : "unknown amount");
  const policyUrl = `${opts.baseUrl.replace(/\/$/, "")}/refund-policy`;
  const fields: Record<string, string> = {};
  if (user) {
    fields.customer_email_address = user.email;
    if (user.name) fields.customer_name = user.name;
    fields.service_date = `Account opened ${formatDay(user.createdAt)}; subscription ${sub?.status ?? "unknown"}.`;
  }
  fields.product_description = `${opts.appName}: an online subscription service, used by signing in at ${opts.baseUrl}.`;
  fields.receipt = invoices.length
    ? invoices
        .slice(0, MAX_LINES)
        .map((i) =>
          [
            i.stripeInvoiceId,
            money(i.amountPaid ?? i.amountDue, i.currency),
            i.status === "paid" && i.paidAt ? `paid ${formatDay(i.paidAt)}` : `status ${i.status}`,
            i.receiptSentAt ? `receipt emailed ${formatDay(i.receiptSentAt)}` : "no receipt recorded",
            i.hostedInvoiceUrl ?? "",
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n")
    : "No invoice for this customer is recorded in the app.";
  fields.refund_policy = `${refundPolicyParagraphs().join("\n\n")}\n\n(Published at ${policyUrl}; last changed ${refundPolicy.updated}.)`;
  fields.refund_policy_disclosure =
    `The payment page linked the refund policy (${policyUrl}) above the pay button, so the customer saw it before paying; the same link is on the account's plan card.`;
  fields.access_activity_log = activity.length
    ? activity.map((a) => `${a.occurredAt.toISOString()} ${a.action} (${a.target})`).join("\n")
    : "No account activity is recorded in the app's audit trail.";
  fields.uncategorized_text =
    `Dispute ${d.stripeDisputeId} for ${money(d.amount, d.currency)}, reason "${d.reason ?? "unknown"}". ` +
    `The charge was made under the subscription the customer started themselves, on the terms and refund policy above.`;

  return {
    disputeId: d.stripeDisputeId,
    amount: money(d.amount, d.currency),
    reason: d.reason ?? "unknown",
    status: d.status,
    evidenceDueBy: d.evidenceDueBy,
    fields,
    byHand: [
      "A screenshot of the payment page showing the refund policy link (the policy text itself is above).",
      "Any emails with the customer from the support inbox.",
    ],
  };
}

/** The pack as plain text, field by field, for an email or the terminal. */
export function renderEvidence(pack: EvidencePack): string {
  const out = [
    `Evidence for dispute ${pack.disputeId} (${pack.amount}, reason: ${pack.reason}, status: ${pack.status})`,
    pack.evidenceDueBy ? `Send by: ${formatDay(pack.evidenceDueBy)}` : "Send by: the date shown in Stripe",
    "",
    "Paste each part into Stripe's dispute form under the field named:",
  ];
  for (const [name, text] of Object.entries(pack.fields)) out.push("", `== ${name} ==`, text);
  out.push("", "Add by hand:", ...pack.byHand.map((b) => `- ${b}`));
  return out.join("\n");
}
