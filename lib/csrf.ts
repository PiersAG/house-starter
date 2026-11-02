import "server-only";

// Request-verification tokens for every state-changing endpoint
// (app-business-core issue 353 SEC.12 leg b; Matt Murphy #68: "SameSite cookies
// + request-verification tokens on every state-changing endpoint").
//
// Two checks, in this order:
//
//   1. SAME ORIGIN. A browser names where a request came from (`Sec-Fetch-Site`
//      and `Origin`). When it does, the request must come from the origin it is
//      sent to (a preview address included), the app's canonical origin, or one
//      listed in config/cors.ts; another website's form or script is refused
//      before anything else runs. A page cannot make a browser lie about its
//      Origin. A client that sends neither header is not a browser, so it
//      cannot carry a victim's cookies by accident.
//   2. THE TOKEN (signed-in endpoints). `x-csrf-token` must equal a token bound
//      to the signed-in user AND this session: HMAC-SHA256 over the user id and
//      the session id, keyed from the sign-in secret (HKDF, its own label, so
//      the key is used for nothing else). Another site cannot read it, and it
//      changes with every new session — sign-out, sign-out-everywhere and a role
//      change (which swaps the session id) all retire the old one.
//
// The session cookie is already SameSite=Lax (Auth.js default), so most
// cross-site writes never carry it; these checks hold even where that does not
// (a same-site subdomain, an old browser). Server actions get Next.js's own
// Origin-against-Host check, so this file guards the API routes.
//
// The page that renders a form passes csrfTokenFor(session) to its client
// component, which sends it back in the header. tests/unit/csrf.test.ts lists
// every write endpoint and fails one that skips the check.

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { allowedOrigins } from "@/lib/cors";
import type { AppUrlEnv } from "@/lib/app-url";

export const CSRF_HEADER = "x-csrf-token";

/** The subset of the Auth.js session this check reads. */
export type CsrfSession = {
  user?: { id?: string | null; sessionId?: string | null } | null;
} | null;

type CsrfEnv = AppUrlEnv & { AUTH_SECRET?: string; NEXTAUTH_SECRET?: string };

const REFUSAL = "This request could not be verified. Reload the page and try again.";

function tokenKey(env: CsrfEnv): Buffer {
  const secret = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set, so request tokens cannot be made or checked.");
  return Buffer.from(hkdfSync("sha256", secret, "", "house-starter/csrf/v1", 32));
}

/** The token for this session, or null when there is no signed-in session. */
export function csrfTokenFor(
  session: CsrfSession,
  env: CsrfEnv = process.env as CsrfEnv,
): string | null {
  const userId = session?.user?.id;
  const sessionId = session?.user?.sessionId;
  if (!userId || !sessionId) return null;
  return createHmac("sha256", tokenKey(env))
    .update(`csrf:v1:${userId}:${sessionId}`)
    .digest("base64url");
}

/** True when a browser says the request came from somewhere else. */
export function crossOrigin(request: Request, env: CsrfEnv = process.env as CsrfEnv): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const own = new URL(request.url).origin;
  if (origin === own) return false;
  return !allowedOrigins(env, own).includes(origin);
}

function refuse(): Response {
  return NextResponse.json({ error: REFUSAL }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

/** For signed-out write endpoints (sign-up, forgot password): the origin check. */
export function verifySameOrigin(request: Request, env: CsrfEnv = process.env as CsrfEnv): Response | null {
  return crossOrigin(request, env) ? refuse() : null;
}

/** For signed-in write endpoints: the origin check, then the session's token. */
export function verifyCsrf(
  request: Request,
  session: CsrfSession,
  env: CsrfEnv = process.env as CsrfEnv,
): Response | null {
  if (crossOrigin(request, env)) return refuse();
  const expected = csrfTokenFor(session, env);
  const given = request.headers.get(CSRF_HEADER);
  if (!expected || !given) return refuse();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse();
  return null;
}
