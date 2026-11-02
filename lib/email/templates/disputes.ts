// The dispute-deadline reminder to the app's owner (PiersAG/app-business-core#370),
// sent once a day in the last days before the evidence deadline by
// lib/disputes/reminders.ts, with the evidence pack filled in.
//
// Built with the `html` tag (./html.ts): every value from Stripe or the customer is
// escaped as text; the pack is shown as preformatted text.

import type { EmailTemplate } from "@/lib/email/send";
import { html } from "@/lib/email/templates/html";
import { renderLayout } from "@/lib/email/templates/layout";
import { formatDay } from "@/lib/email/templates/billing";

export interface DisputeReminderData {
  appName: string;
  disputeId: string;
  /** Already formatted, e.g. "£12.00". */
  amount: string;
  evidenceDueBy: Date;
  daysLeft: number;
  /** The evidence pack as plain text (lib/disputes/evidence.ts renderEvidence). */
  evidence: string;
}

export const disputeReminderTemplate: EmailTemplate<DisputeReminderData> = {
  name: "dispute-deadline-reminder",
  render({ appName, disputeId, amount, evidenceDueBy, daysLeft, evidence }) {
    const due = formatDay(evidenceDueBy);
    const left = daysLeft === 1 ? "1 day" : `${daysLeft} days`;
    const subject = `Reminder: ${left} left to answer the ${amount} dispute (${appName})`;
    const lead = `The dispute of ${amount} (Stripe ${disputeId}) still needs your answer. Send evidence or accept it by ${due}; after that it is lost automatically.`;
    const bodyHtml = html`
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${left} left to answer a dispute</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">${lead}</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">The evidence the app holds is below, under the names of the
        fields in Stripe's dispute form. The steps are in the app's dispute runbook (docs/billing-disputes.md).</p>
      <pre style="margin:0;font-size:13px;line-height:1.5;white-space:pre-wrap">${evidence}</pre>`;
    const text = [`${left} left to answer a dispute`, "", lead, "", evidence].join("\n");
    return { subject, html: renderLayout({ title: subject, bodyHtml, previewText: subject }), text };
  },
};
