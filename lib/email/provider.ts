// Concrete email provider, behind the provider-agnostic interface used by
// lib/email/send.ts. Resend today (API-key-only wiring, no SMTP surface, fits
// the Vercel stack). Swapping providers means rewriting only this file — the
// EmailProvider interface and every call site stay unchanged.
//
// The client is constructed LAZILY at first send (mirrors lib/billing/stripe.ts
// and lib/db.ts): importing this module is side-effect free, and neither the
// build nor a log-mode preview ever needs EMAIL_PROVIDER_API_KEY.

import { Resend } from "resend";

/** A single outbound message. Provider-neutral shape. */
export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** The seam every provider implements. */
export interface EmailProvider {
  send(message: OutboundEmail): Promise<{ id?: string }>;
}

let _client: Resend | null = null;

function getResendClient(): Resend {
  if (_client) return _client;
  const key = process.env.EMAIL_PROVIDER_API_KEY;
  if (!key) {
    throw new Error(
      "lib/email/provider.ts: EMAIL_PROVIDER_API_KEY is not set. It is declared " +
        "deploy-injected in .env.contract (source=secret) — set it and redeploy, " +
        "or run with EMAIL_SEND_MODE=log (no provider needed).",
    );
  }
  _client = new Resend(key);
  return _client;
}

const resendProvider: EmailProvider = {
  async send(message) {
    const { data, error } = await getResendClient().emails.send({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    if (error) {
      throw new Error(`Email provider send failed: ${error.name}: ${error.message}`);
    }
    return { id: data?.id };
  },
};

/** The configured provider. A future swap returns a different implementation. */
export function getEmailProvider(): EmailProvider {
  return resendProvider;
}

/** Test hook — drop the cached client so a test can swap the env key. */
export function __resetEmailProviderForTests(): void {
  _client = null;
}
