// The transactional sending domain (app-business-core issues 470 and 757).
//
// Matt Murphy #131, word for word: "step 2A dedicated sending domain for
// transactional e-mail separate from your marketing". Password resets, receipts
// and account notices go out from a SUBDOMAIN kept for them alone — for example
// mail.getk9coach.com — never from the bare domain marketing mail would use, so
// a marketing campaign's complaints cannot spoil the reputation resets rely on.
//
// Three settings, all read here and nowhere else:
//
//   EMAIL_SENDING_DOMAIN    the transactional subdomain, verified at the provider
//                           with its SPF and DKIM records;
//   EMAIL_FROM              the sender, e.g. "K9Coach <hello@mail.getk9coach.com>";
//                           its domain must be EMAIL_SENDING_DOMAIN exactly;
//   EMAIL_MARKETING_DOMAIN  optional: the domain marketing mail uses, which must
//                           not be the sending domain or inside it.
//
// In live mode (EMAIL_SEND_MODE=live) a problem here stops the send and turns
// /api/health's `email` check red; log mode (CI, previews) never checks.

import "server-only";

/** Two-part public suffixes, so "getk9coach.co.uk" is read as a bare domain. */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "co.nz", "org.nz", "net.nz",
  "co.za", "com.br", "co.jp", "co.in", "com.sg", "com.mx", "co.ie",
]);

export interface SendingDomainCheck {
  ok: boolean;
  /** A fixed, plain reason; never a setting's value. */
  detail: string;
}

/** The domain of an address, from "Name <a@b.c>" or "a@b.c"; null when none. */
export function addressDomain(from: string): string | null {
  const inner = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const at = inner.trim().lastIndexOf("@");
  if (at < 1) return null;
  const domain = inner.trim().slice(at + 1).toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** The registrable domain ("getk9coach.com") of a host name. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".");
  const lastTwo = labels.slice(-2).join(".");
  const keep = TWO_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** True when `host` is a subdomain, not the bare registrable domain. */
export function isSubdomain(host: string): boolean {
  return host.toLowerCase() !== registrableDomain(host);
}

/** Check the three settings. Pure: reads only the env it is given. */
export function checkSendingDomain(env: NodeJS.ProcessEnv = process.env): SendingDomainCheck {
  const sending = (env.EMAIL_SENDING_DOMAIN ?? "").trim().toLowerCase();
  if (!sending) {
    return { ok: false, detail: "EMAIL_SENDING_DOMAIN is not set" };
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(sending)) {
    return { ok: false, detail: "EMAIL_SENDING_DOMAIN is not a domain name" };
  }
  if (!isSubdomain(sending)) {
    return {
      ok: false,
      detail: "EMAIL_SENDING_DOMAIN is a bare domain; use a subdomain kept for transactional mail",
    };
  }
  const fromDomain = addressDomain(env.EMAIL_FROM ?? "");
  if (!fromDomain) {
    return { ok: false, detail: "EMAIL_FROM is not set or has no address" };
  }
  if (fromDomain !== sending) {
    return { ok: false, detail: "EMAIL_FROM does not send from EMAIL_SENDING_DOMAIN" };
  }
  const marketing = (env.EMAIL_MARKETING_DOMAIN ?? "").trim().toLowerCase();
  if (marketing && (marketing === sending || marketing.endsWith(`.${sending}`))) {
    return { ok: false, detail: "EMAIL_MARKETING_DOMAIN is the sending domain or inside it" };
  }
  return { ok: true, detail: "transactional mail sends from its own subdomain" };
}
