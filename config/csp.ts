// Per-app Content-Security-Policy additions — the ONLY file a per-app build
// edits to let the browser load something from another domain
// (PiersAG/app-business-core#446, Matt Murphy #165).
//
// The template's own policy (lib/csp.ts) allows the app's own origin only. An
// app that needs an outside domain — a font host, an analytics endpoint, a map
// tile server — adds ONE entry here per domain and directive, and the entry
// goes through two stages:
//
//   1. REPORT-ONLY. The entry is added with `reportOnlyFrom` set and no
//      `enforcedOn`. The browser keeps enforcing the current policy and, in a
//      second `Content-Security-Policy-Report-Only` header, tries the new one:
//      anything the new policy would block is reported to /api/csp-report and
//      written to the platform log, and nothing breaks for the customer.
//   2. ENFORCED. After at least a week of reports (CSP_REPORT_ONLY_MIN_DAYS),
//      `enforcedOn` is set and the entry joins the enforced policy.
//
// "Enable reporting first, collect violations for a week, see what breaks
// before you block it, then you enforce" — tests/unit/csp-config.test.ts fails
// an entry enforced sooner than that, a wildcard source, an http: source, or an
// 'unsafe-…' keyword. Nothing here is ever read from the request.

export type CspDirective = "script" | "style" | "img" | "font" | "connect" | "frame";

export interface CspSourceEntry {
  /** Which part of the policy the source joins (script-src, img-src, …). */
  directive: CspDirective;
  /** One exact https origin, e.g. "https://fonts.example.com". */
  source: string;
  /** Why the app needs it — read by whoever reviews the change. */
  reason: string;
  /** ISO date the entry shipped report-only. */
  reportOnlyFrom: string;
  /** ISO date it was moved to the enforced policy; absent while report-only. */
  enforcedOn?: string;
}

/** The shortest report-only phase before an entry may be enforced. */
export const CSP_REPORT_ONLY_MIN_DAYS = 7;

/** The template loads nothing from another domain. */
export const CSP_SOURCES: readonly CspSourceEntry[] = [];
