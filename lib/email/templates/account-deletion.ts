// Account-deletion emails (app-business-core issue 722; Matt Murphy #156:
// "deactivate the user immediately but retain the data for 30 more days";
// "confirm complete removal"). Two messages: the request is received (with the
// date the data will be erased), and the erasure is done (with what the law
// still requires the business to keep, and until when).

import type { EmailTemplate } from "@/lib/email/send";
import { html } from "@/lib/email/templates/html";
import { renderLayout } from "@/lib/email/templates/layout";

export interface DeletionRequestedData {
  /** The day the data will be erased, e.g. "2 December 2026". */
  eraseOn: string;
  appName?: string;
}

export const deletionRequestedTemplate: EmailTemplate<DeletionRequestedData> = {
  name: "account-deletion-requested",
  render({ eraseOn, appName = "your account" }) {
    const subject = "Your account is closed and will be deleted";
    const bodyHtml = html`
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">Your account is closed</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">
        We received your request to delete ${appName}. It is closed now: nobody
        can sign in to it. We keep its data for 30 days in case the request was
        a mistake, then delete it automatically on ${eraseOn}.
      </p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#52525b">
        If you did not ask for this, reply to this email straight away.
      </p>`;
    const text = [
      "Your account is closed",
      "",
      `We received your request to delete ${appName}. It is closed now: nobody can sign in to it.`,
      `We keep its data for 30 days in case the request was a mistake, then delete it automatically on ${eraseOn}.`,
      "",
      "If you did not ask for this, reply to this email straight away.",
    ].join("\n");
    return { subject, html: renderLayout({ title: subject, bodyHtml, previewText: subject }), text };
  },
};

export interface DeletionCompletedData {
  /** Plain lines: what the law still requires us to keep, and until when. */
  kept: string[];
  appName?: string;
}

export const deletionCompletedTemplate: EmailTemplate<DeletionCompletedData> = {
  name: "account-deletion-completed",
  render({ kept, appName = "your account" }) {
    const subject = "Your data has been deleted";
    const keptLine =
      kept.length === 0
        ? "We keep nothing else about you."
        : `The law requires us to keep a few records, without your name or email address: ${kept.join("; ")}. Each is deleted when its period ends.`;
    const bodyHtml = html`
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">Your data has been deleted</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">
        Everything we held for ${appName} has now been deleted, and we checked
        that none of it remains.
      </p>
      <p style="margin:0;font-size:15px;line-height:1.6">${keptLine}</p>`;
    const text = [
      "Your data has been deleted",
      "",
      `Everything we held for ${appName} has now been deleted, and we checked that none of it remains.`,
      keptLine,
      "",
      "This is the last email we will send to this address.",
    ].join("\n");
    return { subject, html: renderLayout({ title: subject, bodyHtml, previewText: subject }), text };
  },
};
