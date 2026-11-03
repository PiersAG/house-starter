// Is the sending domain ready? (app-business-core issue 470: "a sending domain
// verified with the SPF/DKIM/DMARC records that verification requires").
//
// The provider checks SPF and DKIM itself; DMARC is a plain DNS record the
// provider does not check, so it is read here: a receiving server looks for
// `_dmarc.<sending domain>` first, then `_dmarc.<registrable domain>`. Run by
// `npm run email:domain-status` (scripts/email-domain-status.ts) once the CEO
// has added the records; pure, so the verdict is unit-tested.

import "server-only";

import type { SendingDomainStatus } from "@/lib/email/provider";
import { registrableDomain } from "@/lib/email/sending-domain";

export interface DomainReadiness {
  ready: boolean;
  /** Plain lines for the CEO, one per record. */
  lines: string[];
}

/** The DMARC policy (p=none|quarantine|reject) from TXT strings, or null. */
export function dmarcPolicy(txt: string[]): string | null {
  const record = txt.map((t) => t.trim()).find((t) => /^v=DMARC1\b/i.test(t));
  if (!record) return null;
  return /(?:^|;)\s*p=([a-z]+)/i.exec(record)?.[1]?.toLowerCase() ?? null;
}

/** Where DMARC is looked up for a sending domain, in order. */
export function dmarcNames(sendingDomain: string): string[] {
  const names = [`_dmarc.${sendingDomain}`];
  const org = registrableDomain(sendingDomain);
  if (org !== sendingDomain) names.push(`_dmarc.${org}`);
  return names;
}

export function judgeDomain(
  domain: string,
  status: SendingDomainStatus,
  dmarc: { name: string; policy: string | null } | null,
): DomainReadiness {
  const lines: string[] = [];
  if (!status.found) {
    return { ready: false, lines: [`${domain}: not added at the email provider yet`] };
  }
  for (const r of status.records) {
    lines.push(`${r.record} (${r.type} ${r.name}): ${r.ok ? "verified" : "not verified yet"}`);
  }
  if (status.region) lines.push(`data region: ${status.region}`);
  const policy = dmarc?.policy ?? null;
  lines.push(
    policy
      ? `DMARC (${dmarc?.name}): found, policy ${policy}`
      : "DMARC: no record found — add a TXT record at _dmarc with v=DMARC1; p=none to start",
  );
  const ready = status.verified && policy !== null;
  lines.push(ready ? "READY: the sending domain is verified" : "NOT READY: finish the records above");
  return { ready, lines };
}
