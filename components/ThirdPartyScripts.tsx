// The one way a third-party script reaches a page (app-business-core issue 807;
// Matt Murphy #59). Rendered by a page with its own path:
//
//   <ThirdPartyScripts path="/pricing" />
//
// It loads each script config/third-party.ts lists for that path, with the
// page's CSP nonce, and nothing at all on a sensitive page (sign-in, sign-up,
// password reset, account, dashboard, billing) — whatever the list says.
// Today the list is empty, so it renders nothing.

import Script from "next/script";
import { headers } from "next/headers";
import { SENSITIVE_PAGES, THIRD_PARTY, type ThirdPartyResource } from "@/config/third-party";

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** True when `path` handles credentials, payment data or administration. */
export function isSensitivePage(path: string): boolean {
  return SENSITIVE_PAGES.some((p) => under(path, p));
}

/** The scripts that may load on `path`. */
export function scriptsFor(path: string, list: readonly ThirdPartyResource[] = THIRD_PARTY): ThirdPartyResource[] {
  if (isSensitivePage(path)) return [];
  return list.filter((r) => r.kinds.includes("script") && r.src && r.pages.some((p) => under(path, p)));
}

export async function ThirdPartyScripts({ path }: { path: string }) {
  const scripts = scriptsFor(path);
  if (scripts.length === 0) return null;
  // The middleware puts this response's policy, nonce included, on the request
  // (lib/csp.ts); a script without the nonce would be blocked.
  const policy = (await headers()).get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  return (
    <>
      {scripts.map((s) => (
        <Script key={s.src} src={s.src} nonce={nonce} strategy="afterInteractive" />
      ))}
    </>
  );
}
