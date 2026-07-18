// Transactional email send path for the house-starter template.
//
// `sendEmail(to, template, data)` is the ONE entry point every product feature
// calls. It is provider-agnostic: a template renders to { subject, html, text }
// and the send path decides what to do with it based on EMAIL_SEND_MODE:
//
//   log  (default) — write a line to the console and capture the message
//                    in-memory. CI and preview deploys run in this mode so they
//                    never send real mail. No provider, no API key needed.
//   live           — send via the configured provider (lib/email/provider.ts).
//
// The provider sits BEHIND this interface and is swappable (Resend today); the
// interface is the graduation, not the provider (spec Candidate 2).

import { getEmailProvider } from "@/lib/email/provider";

export type EmailSendMode = "log" | "live";

/** A fully-rendered message, ready to hand to any provider. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * A named, type-safe email template. `render` maps typed data to a rendered
 * message; the type parameter ties each template to the shape of data it needs,
 * so `sendEmail(to, resetPasswordTemplate, { resetUrl })` is checked at compile
 * time.
 */
export interface EmailTemplate<TData> {
  name: string;
  render(data: TData): RenderedEmail;
}

export interface SendResult {
  mode: EmailSendMode;
  to: string;
  template: string;
  /** Provider message id, when the provider returns one (live mode only). */
  id?: string;
}

/** Resolve and validate EMAIL_SEND_MODE. Defaults to "log" when unset. */
export function getEmailSendMode(): EmailSendMode {
  const raw = (process.env.EMAIL_SEND_MODE ?? "log").trim().toLowerCase();
  if (raw !== "log" && raw !== "live") {
    throw new Error(
      `lib/email/send.ts: EMAIL_SEND_MODE must be "log" or "live" (got ${JSON.stringify(raw)}). ` +
        "Default is log; live is set only in production.",
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Test/observability capture. In log mode every message is pushed here so a
// unit test can assert "a reset email went to this address" without a network
// send. Bounded so a long-running process cannot grow it unboundedly.
// ---------------------------------------------------------------------------

export interface CapturedEmail extends RenderedEmail {
  to: string;
  template: string;
}

const CAPTURE_LIMIT = 100;
const captured: CapturedEmail[] = [];

/** Messages captured in log mode, most-recent last. */
export function getCapturedEmails(): readonly CapturedEmail[] {
  return captured;
}

/** Clear the capture buffer (tests call this between cases). */
export function clearCapturedEmails(): void {
  captured.length = 0;
}

/**
 * Render `template` with `data` and dispatch it to `to`. In log mode the
 * message is logged + captured and no provider is touched; in live mode it is
 * sent via the configured provider using EMAIL_FROM as the sender.
 */
export async function sendEmail<TData>(
  to: string,
  template: EmailTemplate<TData>,
  data: TData,
): Promise<SendResult> {
  const rendered = template.render(data);
  const mode = getEmailSendMode();

  if (mode === "log") {
    // eslint-disable-next-line no-console -- the log mode IS the delivery here.
    console.log(
      `[email:log] to=${to} template=${template.name} subject=${JSON.stringify(rendered.subject)}`,
    );
    captured.push({ to, template: template.name, ...rendered });
    if (captured.length > CAPTURE_LIMIT) captured.shift();
    return { mode: "log", to, template: template.name };
  }

  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error(
      "lib/email/send.ts: EMAIL_FROM is not set but EMAIL_SEND_MODE=live. " +
        "EMAIL_FROM is the app-supplied sender address (source=app in .env.contract).",
    );
  }

  const result = await getEmailProvider().send({
    from,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
  return { mode: "live", to, template: template.name, id: result.id };
}
