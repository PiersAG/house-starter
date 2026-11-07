// Content-Security-Policy for every response (PiersAG/app-business-core#446).
//
// Moved out of middleware.ts so the policy is unit-tested directly and the
// middleware only applies it. What it adds to the policy the middleware built
// before:
//
//   * REPORTING. Every policy names /api/csp-report twice — `report-uri` (read
//     by every browser today) and `report-to` with a `Reporting-Endpoints`
//     header (the newer Reporting API) — so a violation in production is a log
//     line, not a silent breakage nobody hears about (Matt Murphy #165).
//   * A REPORT-ONLY PHASE. A new outside source in config/csp.ts is sent first
//     in `Content-Security-Policy-Report-Only` only; it joins the enforced
//     policy once its report-only week is over. While nothing is report-only,
//     no second header is sent.
//
// Nonce-based script-src — no 'unsafe-inline' for scripts. 'strict-dynamic'
// lets Next.js's nonce'd bootstrap script load its own chunks (and means a host
// listed for scripts is honoured only by browsers too old for 'strict-dynamic';
// a third-party script still needs the nonce).

import "server-only";
import { CSP_SOURCES, type CspDirective, type CspSourceEntry } from "@/config/csp";

export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp-endpoint";

const DIRECTIVE_NAME: Record<CspDirective, string> = {
  script: "script-src",
  style: "style-src",
  img: "img-src",
  font: "font-src",
  connect: "connect-src",
  frame: "frame-src",
};

/** A fresh, unguessable nonce for one response. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function basePolicy(nonce: string): [string, string[]][] {
  return [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]],
    // Styles may be inlined by Next.js/Tailwind; the baseline only requires a
    // nonce on scripts.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
}

/**
 * Whether the policy tells browsers to switch every request to https. Always, except
 * on the one plain-http test server the correctness gate runs Safari's engine against
 * (app-business-core issue 721): WebKit, unlike Chromium and Firefox, applies
 * `upgrade-insecure-requests` to localhost, so over plain http it fetches the page's own
 * scripts and form posts over https and the page never works. Dropped only when BOTH
 * the safe test environment holds (RATE_LIMIT_ALLOW_IN_MEMORY=true and no VERCEL_ENV,
 * the two-part signal lib/auth-rate-limit.ts uses) AND that server asks for it with
 * CSP_PLAIN_HTTP_TEST_SERVER=1. A deployed app always has VERCEL_ENV, so it always
 * sends the directive; and it is served over https, where the directive changes nothing.
 */
export function upgradesInsecureRequests(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const deployed = (env.VERCEL_ENV ?? "").trim().length > 0;
  const safeTest = !deployed && env.RATE_LIMIT_ALLOW_IN_MEMORY === "true";
  return !(safeTest && env.CSP_PLAIN_HTTP_TEST_SERVER === "1");
}

/** The policy text for a nonce plus the given outside sources. */
export function buildCsp(
  nonce: string,
  extra: readonly CspSourceEntry[] = [],
  env: Record<string, string | undefined> = process.env,
): string {
  const policy = basePolicy(nonce);
  for (const entry of extra) {
    const name = DIRECTIVE_NAME[entry.directive];
    let row = policy.find(([n]) => n === name);
    if (!row) {
      // connect-src and frame-src fall back to default-src ('self') until a
      // source is added; adding one must keep 'self'.
      row = [name, ["'self'"]];
      policy.splice(policy.length - 4, 0, row);
    }
    if (!row[1].includes(entry.source)) row[1].push(entry.source);
  }
  return [
    ...policy.map(([n, values]) => `${n} ${values.join(" ")}`),
    ...(upgradesInsecureRequests(env) ? ["upgrade-insecure-requests"] : []),
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join("; ");
}

/** True when the entry has finished its report-only phase. */
export function isEnforced(entry: CspSourceEntry): boolean {
  return Boolean(entry.enforcedOn);
}

/**
 * Every CSP header for one response: the enforced policy, the report-only
 * policy (only while some source is still report-only) and the reporting
 * endpoint.
 */
export function cspHeaders(
  nonce: string,
  sources: readonly CspSourceEntry[] = CSP_SOURCES,
): Record<string, string> {
  const enforced = sources.filter(isEnforced);
  const headers: Record<string, string> = {
    "Content-Security-Policy": buildCsp(nonce, enforced),
    "Reporting-Endpoints": `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`,
  };
  if (enforced.length !== sources.length) {
    headers["Content-Security-Policy-Report-Only"] = buildCsp(nonce, sources);
  }
  return headers;
}

/** Set every CSP header on a response's (or request's) headers. */
export function applyCsp(
  target: Headers,
  nonce: string,
  sources: readonly CspSourceEntry[] = CSP_SOURCES,
): void {
  for (const [name, value] of Object.entries(cspHeaders(nonce, sources))) {
    target.set(name, value);
  }
}
