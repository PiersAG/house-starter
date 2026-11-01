// Base email layout for the house-starter template.
//
// A single, inline-styled HTML shell every transactional email renders into.
// Inline styles only (no <style> block, no external CSS) because email clients
// strip <head> styles and never fetch remote assets. Kept deliberately plain
// and accessible: real text, adequate contrast, a visible link fallback.
//
// Built with the `html` tag (./html.ts): every value is escaped unless it is
// html output, so nothing a user typed can become markup (issue 758).

import { html, type SafeHtml } from "@/lib/email/templates/html";

export { escapeHtml } from "@/lib/email/templates/html";

export interface LayoutOptions {
  /** The <title> and the preheader intent — not shown in the body. */
  title: string;
  /** The message body, built with the `html` tag. */
  bodyHtml: SafeHtml;
  /** Optional hidden preview text shown in the inbox list before opening. */
  previewText?: string;
}

export function renderLayout({ title, bodyHtml, previewText }: LayoutOptions): string {
  const preheader = previewText
    ? html`<span style="display:none;max-height:0;overflow:hidden;opacity:0">${previewText}</span>`
    : null;
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b">
    ${preheader}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5">
      <tr>
        <td align="center" style="padding:32px 16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px">
            <tr>
              <td>
                ${bodyHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.value;
}
