// Concrete email provider, behind the provider-agnostic interface used by
// lib/email/send.ts. Resend today (API-key-only wiring, no SMTP surface, fits
// the Vercel stack). Swapping providers means rewriting only this file — the
// EmailProvider interface and every call site stay unchanged.
//
// ONE SETTING CHOOSES IT (app-business-core issue 470): EMAIL_PROVIDER names the
// provider, "resend" when unset. A second provider is one more entry in
// PROVIDERS below; an unknown name is refused at the first send, never ignored.
//
// The client is constructed LAZILY at first send (mirrors lib/billing/stripe.ts
// and lib/db.ts): importing this module is side-effect free, and neither the
// build nor a log-mode preview ever needs EMAIL_PROVIDER_API_KEY.

import "server-only";

import { Resend } from "resend";
import { readSecret } from "@/lib/secrets";

/** A single outbound message. Provider-neutral shape. */
export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** One DNS record the provider asks for, and whether it has seen it. */
export interface DomainRecordStatus {
  /** "SPF", "DKIM", "MX" — the provider's own label. */
  record: string;
  type: string;
  name: string;
  ok: boolean;
}

/** What the provider says about a sending domain. */
export interface SendingDomainStatus {
  found: boolean;
  verified: boolean;
  /** The provider's data region, e.g. "eu-west-1". */
  region?: string;
  records: DomainRecordStatus[];
}

/** The seam every provider implements. */
export interface EmailProvider {
  readonly name: EmailProviderName;
  send(message: OutboundEmail): Promise<{ id?: string }>;
  /** The provider's verification state for a sending domain (SPF and DKIM). */
  domainStatus(domain: string): Promise<SendingDomainStatus>;
}

export const EMAIL_PROVIDER_NAMES = ["resend"] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDER_NAMES)[number];

/** The configured provider's name. Throws on a name no provider answers to. */
export function emailProviderName(env: NodeJS.ProcessEnv = process.env): EmailProviderName {
  const raw = (env.EMAIL_PROVIDER ?? "resend").trim().toLowerCase();
  if (!(EMAIL_PROVIDER_NAMES as readonly string[]).includes(raw)) {
    throw new Error(
      `lib/email/provider.ts: EMAIL_PROVIDER must be one of ${EMAIL_PROVIDER_NAMES.join(", ")} ` +
        `(got ${JSON.stringify(raw)}).`,
    );
  }
  return raw as EmailProviderName;
}

let _client: Resend | null = null;

function getResendClient(): Resend {
  if (_client) return _client;
  const key = readSecret("EMAIL_PROVIDER_API_KEY");
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
  name: "resend",
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
  async domainStatus(domain) {
    const client = getResendClient();
    const listed = await client.domains.list();
    if (listed.error) {
      throw new Error(`Email provider domain list failed: ${listed.error.name}: ${listed.error.message}`);
    }
    const match = (listed.data?.data ?? []).find((d) => d.name.toLowerCase() === domain.toLowerCase());
    if (!match) return { found: false, verified: false, records: [] };
    const got = await client.domains.get(match.id);
    if (got.error || !got.data) {
      throw new Error(`Email provider domain read failed: ${got.error?.name}: ${got.error?.message}`);
    }
    return {
      found: true,
      verified: got.data.status === "verified",
      region: got.data.region,
      records: got.data.records.map((r) => ({
        record: r.record,
        type: r.type,
        name: r.name,
        ok: r.status === "verified",
      })),
    };
  },
};

const PROVIDERS: Record<EmailProviderName, EmailProvider> = {
  resend: resendProvider,
};

/** The provider EMAIL_PROVIDER names. */
export function getEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  return PROVIDERS[emailProviderName(env)];
}

/** Test hook — drop the cached client so a test can swap the env key. */
export function __resetEmailProviderForTests(): void {
  _client = null;
}
