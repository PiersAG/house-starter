// CORS: an explicit allowlist, never a wildcard, never a reflected origin
// (PiersAG/app-business-core#742).
//
// Before this file the template sent no CORS headers at all, which is safe only
// for as long as nobody adds one: the first `Access-Control-Allow-Origin: *`,
// or a handler that echoes the caller's Origin back with credentials, would let
// any website read a signed-in user's data. The policy is now written down and
// guarded instead of resting on an absence:
//
//   * The allowed origins are the app's own canonical origin (server-side
//     configuration, lib/app-url.ts) plus the hard-coded list in
//     config/cors.ts. Nothing else, and never anything from the request.
//   * A request whose Origin exactly matches the list gets that origin back —
//     the list's own string, not the request's — with credentials allowed and
//     `Vary: Origin`. Credentials are only ever sent with one exact origin;
//     this file has no code path that writes a wildcard.
//   * Every other origin gets no CORS header, and its preflight is refused
//     with 403.
//
// The middleware calls `corsPreflight` for an OPTIONS preflight and
// `applyCors` on every other response. tests/unit/cors-guard.test.ts fails any
// other file that sets a CORS header.

import { CORS_ALLOWED_ORIGINS } from "@/config/cors";
import { canonicalBaseUrl, type AppUrlEnv } from "@/lib/app-url";

export const CORS_ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE";
export const CORS_ALLOWED_HEADERS = "Content-Type";
export const CORS_MAX_AGE_SECONDS = 600;

/** The exact origin (scheme://host[:port]) of a URL, or null if it is not one. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (/\*/.test(parsed.host)) return null; // a wildcard host is not an origin
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Every origin allowed to make credentialed cross-origin requests. `requestOrigin`
 * is passed through to canonicalBaseUrl, which uses it only in local development
 * (no VERCEL_ENV); a deployed app never reads it.
 */
export function allowedOrigins(
  env: AppUrlEnv = process.env as AppUrlEnv,
  requestOrigin?: string,
  listed: readonly string[] = CORS_ALLOWED_ORIGINS,
): string[] {
  const out: string[] = [];
  try {
    const own = originOf(canonicalBaseUrl(env, requestOrigin));
    if (own) out.push(own);
  } catch {
    // No canonical URL configured: only the hard-coded list applies.
  }
  for (const entry of listed) {
    const origin = originOf(entry);
    if (origin && origin === entry && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * The allowlist entry the Origin header matches EXACTLY, or null. Returns the
 * list's own string so the response never carries a value the caller wrote.
 */
export function matchOrigin(origin: string | null, allowed: readonly string[]): string | null {
  if (!origin) return null;
  return allowed.find((entry) => entry === origin) ?? null;
}

/** The CORS headers for a non-preflight response. */
export function corsHeaders(
  origin: string | null,
  allowed: readonly string[],
): Record<string, string> {
  const match = matchOrigin(origin, allowed);
  // Vary: Origin always — the answer depends on the Origin header, so a cache
  // must never hand one origin's answer to another.
  if (!match) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": match,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

/** True when the request is a CORS preflight (OPTIONS with a requested method). */
export function isPreflight(method: string, headers: Headers): boolean {
  return method === "OPTIONS" && headers.has("access-control-request-method");
}

/** The answer to a preflight: 204 with the headers for a listed origin, else 403. */
export function corsPreflight(
  origin: string | null,
  allowed: readonly string[],
): { status: number; headers: Record<string, string> } {
  const match = matchOrigin(origin, allowed);
  if (!match) return { status: 403, headers: { Vary: "Origin" } };
  return {
    status: 204,
    headers: {
      ...corsHeaders(match, allowed),
      "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
      "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
      "Access-Control-Max-Age": String(CORS_MAX_AGE_SECONDS),
    },
  };
}

/** Set the CORS headers for this request's Origin on a response. */
export function applyCors(target: Headers, origin: string | null, allowed: readonly string[]): void {
  for (const [name, value] of Object.entries(corsHeaders(origin, allowed))) {
    if (name === "Vary") {
      // Added to, never replaced: Next.js varies its own responses on other
      // request headers, and dropping those would let a cache mix them up.
      const vary = target.get("Vary");
      if (!vary) target.set("Vary", value);
      else if (!/(^|,)\s*origin\s*(,|$)/i.test(vary)) target.set("Vary", `${vary}, ${value}`);
    } else {
      target.set(name, value);
    }
  }
}
