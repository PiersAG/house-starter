// `npm run email:domain-status` — is the transactional sending domain ready?
// (app-business-core issue 470). Asks the email provider for its SPF and DKIM
// verification of EMAIL_SENDING_DOMAIN, reads the DMARC record from DNS, and
// prints one plain line per record. Exit 0 when ready, 1 when not, 2 when the
// settings are missing. Never prints a key.
//
// Needs EMAIL_SENDING_DOMAIN and the provider's key in the environment
// (lib/email/provider.ts names the key when it is missing).

import "./server-only-node.cjs";
import { resolveTxt } from "node:dns/promises";
import { getEmailProvider } from "../lib/email/provider";
import { dmarcNames, dmarcPolicy, judgeDomain } from "../lib/email/domain-check";

async function main(): Promise<number> {
  const domain = (process.env.EMAIL_SENDING_DOMAIN ?? "").trim().toLowerCase();
  if (!domain) {
    console.error("Set EMAIL_SENDING_DOMAIN first (and the provider's key, which the provider asks for).");
    return 2;
  }
  const status = await getEmailProvider().domainStatus(domain);
  let dmarc: { name: string; policy: string | null } | null = null;
  for (const name of dmarcNames(domain)) {
    const txt = await resolveTxt(name).then(
      (rows) => rows.map((parts) => parts.join("")),
      () => [] as string[],
    );
    const policy = dmarcPolicy(txt);
    if (policy) {
      dmarc = { name, policy };
      break;
    }
  }
  const verdict = judgeDomain(domain, status, dmarc);
  for (const line of verdict.lines) console.log(line);
  return verdict.ready ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`email:domain-status failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
