// The live wiring for the privacy pipeline: the account's own database through
// lib/db.ts and the provisioner, and the confirmation email through
// lib/email/send.ts. Kept apart from lib/privacy/deletion.ts so the pipeline's
// tests inject fakes and never open a real database or send mail.

import "server-only";

import { getDb } from "@/lib/db";
import { sendEmail } from "@/lib/email/send";
import {
  deletionCompletedTemplate,
  deletionRequestedTemplate,
} from "@/lib/email/templates/account-deletion";
import { getProvisioner } from "@/lib/tenant/provisioner";
import type { ErasureResult, TenantPlane } from "@/lib/privacy/deletion";

/** Open and remove tenant databases the way this environment does. */
export const liveTenantPlane: TenantPlane = {
  open: (tenantId) => getDb(tenantId),
  destroy: async (tenantId) => {
    try {
      return await getProvisioner().destroy(tenantId);
    } catch (e) {
      console.error("privacy: removing the tenant database failed", e instanceof Error ? e.message : e);
      return false;
    }
  },
};

/** "2 December 2026": the date as the emails and the page show it. */
export function longDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The "we have received your request" email. Never throws. */
export async function sendDeletionRequested(email: string, deletionDueAt: Date): Promise<void> {
  try {
    await sendEmail(email, deletionRequestedTemplate, { eraseOn: longDate(deletionDueAt) });
  } catch (e) {
    console.error("privacy: the deletion-request email failed", e instanceof Error ? e.message : e);
  }
}

/** The "your data has been deleted" email: what is still kept, and until when. */
export async function sendErasureConfirmation(email: string, result: ErasureResult): Promise<void> {
  const kept = result.retained.map(
    (r) => `${r.count} ${r.table === "billingInvoices" ? "invoice" : "payment dispute"} record(s) until ${longDate(new Date(r.expiresAt))} (${r.legalBasis})`,
  );
  await sendEmail(email, deletionCompletedTemplate, { kept });
}
