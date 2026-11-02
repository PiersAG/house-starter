// The one way a third-party script reaches a page (app-business-core issue 807;
// Matt Murphy step 59). Rendered by a page with its own path:
//
//   <ThirdPartyScripts path="/pricing" />
//
// It loads each script config/third-party.ts lists for that path, with the
// page's CSP nonce, and nothing at all on a sensitive page (sign-in, sign-up,
// password reset, account, dashboard, billing) — whatever the list says.
// A script that reads personal data waits for the person's plain-language
// agreement (components/ConsentPrompt.tsx, issue 745). Today the list is empty,
// so it renders nothing.

import Script from "next/script";
import { cookies, headers } from "next/headers";
import { ConsentPrompt } from "@/components/ConsentPrompt";
import { CONSENT_COOKIE, parseConsent } from "@/lib/privacy/consent";
import { SENSITIVE_PAGES, THIRD_PARTY, type ThirdPartyResource } from "@/config/third-party";

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** True when `path` handles credentials, payment data or administration. */
export function isSensitivePage(path: string): boolean {
  return SENSITIVE_PAGES.some((p) => under(path, p));
}

/** The scripts that may load on `path` (before any consent is considered). */
function listedFor(path: string, list: readonly ThirdPartyResource[]): ThirdPartyResource[] {
  if (isSensitivePage(path)) return [];
  return list.filter((r) => r.kinds.includes("script") && r.src && r.pages.some((p) => under(path, p)));
}

/**
 * The scripts that load on `path`. One that reads personal data loads only when
 * the person has agreed to it (`agreed` holds the names they agreed to).
 */
export function scriptsFor(
  path: string,
  list: readonly ThirdPartyResource[] = THIRD_PARTY,
  agreed: ReadonlySet<string> = new Set(),
): ThirdPartyResource[] {
  return listedFor(path, list).filter((r) => !r.personalData || agreed.has(r.name));
}

/** The personal-data scripts on `path` still waiting for the person's answer. */
export function consentPendingFor(
  path: string,
  list: readonly ThirdPartyResource[] = THIRD_PARTY,
  agreed: ReadonlySet<string> = new Set(),
): ThirdPartyResource[] {
  return listedFor(path, list).filter((r) => r.personalData && !agreed.has(r.name));
}

export async function ThirdPartyScripts({ path }: { path: string }) {
  const agreed = parseConsent((await cookies()).get(CONSENT_COOKIE)?.value);
  const pending = consentPendingFor(path, THIRD_PARTY, agreed);
  const scripts = scriptsFor(path, THIRD_PARTY, agreed);
  if (scripts.length === 0 && pending.length === 0) return null;
  // The middleware puts this response's policy, nonce included, on the request
  // (lib/csp.ts); a script without the nonce would be blocked.
  const policy = (await headers()).get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  return (
    <>
      {scripts.map((s) => (
        <Script key={s.src} src={s.src} nonce={nonce} strategy="afterInteractive" />
      ))}
      {pending.length > 0 ? (
        <ConsentPrompt names={pending.map((r) => r.name)} questions={pending.map((r) => r.consent ?? r.dataAccess)} />
      ) : null}
    </>
  );
}
