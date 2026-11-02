// The edge firewall rule set (PiersAG/app-business-core#511, #754, #755).
//
// ONE SWITCH. Which edge firewall sits in front of the app is a CEO decision
// (#702). `EDGE_FIREWALL_PROVIDER` below is that decision, in one place; the
// rule set under it is the same whichever provider applies it:
//
//   "none"       no edge firewall. The rules still run INSIDE the app on every
//                route handler and server action that is rate limited
//                (lib/abuse/route-limit.ts), so an attack payload to an API
//                route is refused and scored even with nothing in front.
//   "vercel"     Vercel's firewall applies the rules at the host's edge, before
//                the request reaches the app. Nothing sits in front of the
//                host, so there is no direct path round it (#755 does not arise).
//   "cloudflare" Cloudflare applies the rules, in front of the host. Then the
//                host must refuse traffic that did not come through Cloudflare
//                (#755): see `originLock` below and docs/edge-firewall.md.
//
// Applying the CEO's choice: set the provider here, then create the rules below
// at that provider (docs/edge-firewall.md lists each rule's setting, provider
// by provider), then run `node scripts/edge-check.mjs <production URL>`, which
// sends the attack payloads and normal requests and fails unless the attacks
// are blocked and normal traffic passes.
//
// Both states are tested (tests/unit/edge-firewall.test.ts): every provider
// value, and every rule against attack payloads and against ordinary traffic.

export type EdgeProvider = "none" | "vercel" | "cloudflare";

/** The CEO's choice on #702. "none" until it is made. */
export const EDGE_FIREWALL_PROVIDER: EdgeProvider = "none";

/** What a rule does at the edge. */
export type EdgeAction = "deny" | "challenge";

export type EdgeRule = {
  id: string;
  /** What it stops, in plain words — shown in the docs and the edge check. */
  purpose: string;
  /** Which part of the request the patterns are matched against. */
  on: "path" | "query" | "user-agent";
  /** Case-insensitive patterns; any one matching is a hit. */
  patterns: readonly RegExp[];
  action: EdgeAction;
};

/**
 * The managed-style rule set (#511: "define the managed/custom rule set (SQLi,
 * XSS, path traversal, bad bots)"). Patterns are matched against the DECODED
 * path and query, so `%2e%2e%2f` is seen as `../`. Kept narrow on purpose: a
 * rule that blocks a real customer's search box is worse than no rule, and the
 * app's own input validation stays the main defence.
 */
export const EDGE_RULES: readonly EdgeRule[] = [
  {
    id: "sqli",
    purpose: "SQL injection payloads in the query string",
    on: "query",
    patterns: [
      /\bunion\b[\s\S]{0,40}\bselect\b/i,
      /'\s*(or|and)\s*'?\d+'?\s*=\s*'?\d+/i,
      /\b(sleep|benchmark|pg_sleep)\s*\(/i,
      /\binformation_schema\b/i,
      /;\s*(drop|delete|insert|update|alter)\s+\w/i,
      /'\s*;?\s*--/,
    ],
    action: "deny",
  },
  {
    id: "xss",
    purpose: "Script injection payloads in the query string",
    on: "query",
    patterns: [/<\s*script\b/i, /javascript\s*:/i, /\bon(error|load|mouseover)\s*=/i, /<\s*iframe\b/i],
    action: "deny",
  },
  {
    id: "path-traversal",
    purpose: "Path traversal and requests for server files",
    on: "path",
    patterns: [/\.\.[/\\]/, /\/etc\/(passwd|shadow)\b/i, /\/\.(env|git|aws|ssh)(\/|$)/i, /\/proc\/self\//i],
    action: "deny",
  },
  {
    id: "scanner-paths",
    purpose: "Reconnaissance for software the app does not run (WordPress, phpMyAdmin, …)",
    on: "path",
    patterns: [/\/wp-(admin|login|content|includes)\b/i, /\/xmlrpc\.php$/i, /\/phpmyadmin\b/i, /\.(php|asp|aspx|jsp|cgi)$/i],
    action: "deny",
  },
  {
    id: "bad-bots",
    purpose: "Known attack and scanning tools, by user agent",
    on: "user-agent",
    patterns: [/sqlmap/i, /nikto/i, /\bnmap\b/i, /masscan/i, /zgrab/i, /nuclei/i, /acunetix/i, /wpscan/i, /gobuster/i, /dirbuster/i, /\bhydra\b/i],
    action: "deny",
  },
];

/**
 * Edge rate limits on the sign-in routes (#754, Matt Murphy #78: "your login
 * registration and password reset endpoints should never accept more than a
 * defined number of requests per IP per minute … at the edge before the request
 * ever reaches your server" and "rate limiting rules that block or challenge
 * any IP exceeding thresholds on authentication routes"). Per client address,
 * per minute: past `challengeAbove` the edge challenges, past `denyAbove` it
 * blocks. Set above the app's own limits (lib/auth-rate-limit.ts), so the edge
 * only acts on a flood and a person mistyping a password never meets it.
 */
export const EDGE_AUTH_RATE_LIMITS = {
  paths: ["/login", "/signup", "/forgot-password", "/reset-password", "/api/auth/"],
  windowSeconds: 60,
  challengeAbove: 20,
  denyAbove: 60,
} as const;

/**
 * Bot management on high-value routes (#754, Matt Murphy #78: "bot management
 * rules that protect high value routes from automated scraping and
 * reconnaissance"; Matt Murphy #186: "so automated bots they get blocked before
 * they even reach your rate limiter"). At the edge, automated traffic that is
 * not a verified good bot (search engines) is challenged on these paths, using
 * the provider's own bot detection; the app's rate limiter sits behind it.
 */
export const EDGE_BOT_PROTECTED_PATHS = [
  "/signup",
  "/login",
  "/pricing",
  "/api/auth/",
  "/api/billing/checkout",
] as const;

/**
 * #755 — only when a proxy sits in front of the host ("cloudflare"): the host
 * accepts a request only if it came through the proxy. Cloudflare adds a
 * secret header (a Transform Rule) that the host checks; requests without it —
 * straight to the *.vercel.app address, or to an address found in DNS history —
 * are refused. TLS stays end to end: Cloudflare's SSL mode "Full (strict)",
 * with the host's own certificate (docs/edge-firewall.md).
 */
export const ORIGIN_LOCK = {
  header: "x-origin-verify",
} as const;

export type EdgeRequest = { path: string; query: string; userAgent: string };

/** Decode once, tolerating a malformed escape (an attack payload often is one). */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** The first rule a request trips, or null. Pure; used by the app and the edge check. */
export function matchEdgeRule(req: EdgeRequest, rules: readonly EdgeRule[] = EDGE_RULES): EdgeRule | null {
  const parts = {
    path: decoded(req.path),
    query: decoded(req.query),
    "user-agent": req.userAgent,
  } as const;
  for (const rule of rules) {
    const target = parts[rule.on];
    if (target && rule.patterns.some((p) => p.test(target))) return rule;
  }
  return null;
}

/**
 * Should the host refuse this request because it skipped the proxy? Only ever
 * true with a proxy in front ("cloudflare"); with "none" or "vercel" there is no
 * proxy to skip. A proxy chosen but no shared value configured fails CLOSED.
 */
export function originLockRefuses(
  provider: EdgeProvider,
  headerValue: string | null,
  expected: string | undefined,
): boolean {
  if (provider !== "cloudflare") return false;
  if (!expected) return true;
  if (headerValue === null || headerValue.length !== expected.length) return true;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ headerValue.charCodeAt(i);
  return diff !== 0;
}
