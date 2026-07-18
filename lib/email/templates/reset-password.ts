// Password-reset email template. Renders the reset link into the base layout
// and a plain-text alternative. The only generic transactional email the
// template ships; per-app product emails live in the app's own templates dir.

import type { EmailTemplate } from "@/lib/email/send";
import { escapeHtml, renderLayout } from "@/lib/email/templates/layout";

export interface ResetPasswordData {
  /** Absolute URL the recipient clicks to set a new password. */
  resetUrl: string;
  /** Product name shown in the copy; defaults to a neutral placeholder. */
  appName?: string;
}

export const resetPasswordTemplate: EmailTemplate<ResetPasswordData> = {
  name: "reset-password",
  render({ resetUrl, appName = "your account" }) {
    const safeUrl = escapeHtml(resetUrl);
    const safeApp = escapeHtml(appName);
    const subject = "Reset your password";

    const bodyHtml = `
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">Reset your password</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">
        We received a request to reset the password for ${safeApp}. Click the
        button below to choose a new one. This link expires in one hour and can
        be used once.
      </p>
      <p style="margin:0 0 24px">
        <a href="${safeUrl}"
           style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">
          Reset password
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#52525b">
        If the button doesn't work, copy and paste this link into your browser:
      </p>
      <p style="margin:0 0 24px;font-size:13px;line-height:1.6;word-break:break-all">
        <a href="${safeUrl}" style="color:#2563eb">${safeUrl}</a>
      </p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#52525b">
        If you didn't request this, you can safely ignore this email — your
        password won't change.
      </p>`;

    const text = [
      "Reset your password",
      "",
      `We received a request to reset the password for ${appName}.`,
      "Open this link to choose a new one (expires in one hour, single use):",
      "",
      resetUrl,
      "",
      "If you didn't request this, you can safely ignore this email.",
    ].join("\n");

    return {
      subject,
      html: renderLayout({ title: subject, bodyHtml, previewText: "Reset your password" }),
      text,
    };
  },
};
