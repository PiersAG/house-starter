// Reading a browser's CSP violation report (PiersAG/app-business-core#446,
// Matt Murphy #165) — the pure half of app/api/csp-report/route.ts.
//
// Browsers send two shapes:
//   * `application/csp-report` (the `report-uri` directive):
//       { "csp-report": { "document-uri", "effective-directive" |
//         "violated-directive", "blocked-uri", "disposition" } }
//   * `application/reports+json` (the Reporting API, `report-to`):
//       [ { "type": "csp-violation", "body": { "documentURL",
//           "effectiveDirective", "blockedURL", "disposition" } } ]
//
// Only what is needed to decide whether to allow a source is kept: the
// directive, the blocked origin (or keyword such as `inline`), the page's PATH
// and whether the policy was enforced or report-only. Query strings and full
// URLs are dropped — they can carry tokens or personal data — and so is
// everything else in the report (script samples, referrers).

/** The largest report body read; anything bigger is ignored. */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;
/** The most violations logged from one request. */
export const CSP_REPORT_MAX_ITEMS = 10;

export interface CspViolation {
  directive: string;
  blocked: string;
  page: string;
  disposition: "enforce" | "report";
}

type Raw = Record<string, unknown>;

function text(value: unknown, max = 100): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** An origin for a URL, the keyword for a non-URL value (inline, eval, data). */
export function blockedSource(value: unknown): string {
  const raw = text(value, 2048);
  if (!raw) return "unknown";
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "wss:") {
      return url.origin;
    }
    return url.protocol.replace(/:$/, "");
  } catch {
    return /^[a-z-]{1,30}$/i.test(raw) ? raw.toLowerCase() : "unknown";
  }
}

/** The path of a page URL, with no query string or fragment. */
export function pagePath(value: unknown): string {
  const raw = text(value, 2048);
  try {
    return new URL(raw).pathname.slice(0, 200);
  } catch {
    return "unknown";
  }
}

function toViolation(directive: unknown, blocked: unknown, page: unknown, disposition: unknown): CspViolation {
  return {
    directive: text(directive).split(" ")[0] || "unknown",
    blocked: blockedSource(blocked),
    page: pagePath(page),
    disposition: disposition === "report" ? "report" : "enforce",
  };
}

/** Every violation in a report body, or [] for anything that is not a report. */
export function parseCspReport(body: unknown): CspViolation[] {
  const out: CspViolation[] = [];
  if (Array.isArray(body)) {
    for (const item of body.slice(0, CSP_REPORT_MAX_ITEMS)) {
      const report = item as Raw | null;
      if (!report || report.type !== "csp-violation") continue;
      const b = (report.body ?? {}) as Raw;
      out.push(toViolation(b.effectiveDirective, b.blockedURL, b.documentURL ?? report.url, b.disposition));
    }
    return out;
  }
  const legacy = (body as Raw | null)?.["csp-report"] as Raw | undefined;
  if (legacy && typeof legacy === "object") {
    out.push(
      toViolation(
        legacy["effective-directive"] ?? legacy["violated-directive"],
        legacy["blocked-uri"],
        legacy["document-uri"],
        legacy.disposition,
      ),
    );
  }
  return out;
}
