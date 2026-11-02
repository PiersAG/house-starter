// Shared helpers for the sign-in and session specs (PiersAG/app-business-core
// bundle S8: #514, #516, #798). API-level only — no browser — so these specs
// run anywhere the app runs.
//
// THE SECRET. The specs mint and read session tokens the way the server does,
// so they need the same session secret. It is the throwaway CI value (the same
// fallback playwright.config.ts gives the web server), never a real one.
//
// THE ADDRESS. Sign-in is limited per client address (lib/auth-rate-limit.ts),
// and a local run has no proxy, so every request would share one budget. Each
// spec passes its own documentation-range address (RFC 5737, 203.0.113.0/24)
// so the specs do not spend each other's budget.

import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { decode, encode } from "@auth/core/jwt";
import type { JWT } from "next-auth/jwt";
import { CSRF_HEADER, csrfTokenFor } from "@/lib/csrf";

export const BASE_URL = "http://localhost:3000";
export const SESSION_COOKIE = "authjs.session-token";
export const SESSION_SECRET =
  process.env.AUTH_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "ci-e2e-only-dummy-secret-not-used-anywhere-real";
export const PASSWORD = "S8 sign-in tests passphrase";

/** A request context with its own client address and its own cookie jar. */
export async function client(address: string, cookie?: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { "x-forwarded-for": address },
    storageState: {
      cookies: cookie
        ? [
            {
              name: SESSION_COOKIE,
              value: cookie,
              domain: "localhost",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: false,
              sameSite: "Lax",
            },
          ]
        : [],
      origins: [],
    },
  });
}

/** Create the account (201) or accept that an earlier attempt did (409). */
export async function ensureAccount(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post("/api/auth/signup", { data: { email, password: PASSWORD } });
  if (res.status() !== 201 && res.status() !== 409) {
    throw new Error(`sign-up for ${email} answered ${res.status()}: ${await res.text()}`);
  }
}

export async function csrfToken(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.get("/api/auth/csrf");
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

/**
 * Sign in through the public credentials endpoint (the one the login form's
 * action reaches) and return the response WITHOUT following its redirect.
 */
export async function postSignIn(
  ctx: APIRequestContext,
  email: string,
  callbackUrl = "/dashboard",
) {
  return ctx.post("/api/auth/callback/credentials", {
    form: { csrfToken: await csrfToken(ctx), email, password: PASSWORD, callbackUrl },
    maxRedirects: 0,
  });
}

/** The session cookie this context now holds, or null. */
export async function sessionCookie(ctx: APIRequestContext): Promise<string | null> {
  const state = await ctx.storageState();
  return state.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? null;
}

/** Sign in and return the session token, failing loudly when there is none. */
export async function signIn(ctx: APIRequestContext, email: string): Promise<string> {
  const res = await postSignIn(ctx, email);
  const token = await sessionCookie(ctx);
  if (!token) throw new Error(`no session after signing in ${email} (status ${res.status()})`);
  return token;
}

export async function readToken(token: string): Promise<JWT> {
  const claims = await decode({ token, secret: SESSION_SECRET, salt: SESSION_COOKIE });
  if (!claims) throw new Error("token did not decode");
  return claims as JWT;
}

/**
 * The request token a signed-in page would send with a write (lib/csrf.ts,
 * app-business-core issue 353), worked out from the session cookie the same
 * way the server does.
 */
export async function requestToken(cookie: string): Promise<string> {
  const claims = await readToken(cookie);
  const token = csrfTokenFor(
    { user: { id: (claims.id ?? claims.sub) as string, sessionId: claims.sessionId as string } },
    { AUTH_SECRET: SESSION_SECRET },
  );
  if (!token) throw new Error("the session has no id or session id, so it has no request token");
  return token;
}

/** Headers for a write from this signed-in context: same origin, with its request token. */
export async function writeHeaders(ctx: APIRequestContext): Promise<Record<string, string>> {
  const cookie = await sessionCookie(ctx);
  if (!cookie) throw new Error("writeHeaders needs a signed-in context");
  return { origin: BASE_URL, [CSRF_HEADER]: await requestToken(cookie) };
}

export async function mintToken(
  claims: Record<string, unknown>,
  options: { secret?: string; maxAge?: number } = {},
): Promise<string> {
  return encode({
    token: claims,
    secret: options.secret ?? SESSION_SECRET,
    salt: SESSION_COOKIE,
    maxAge: options.maxAge ?? 3600,
  });
}

/**
 * Follow a redirect chain one hop at a time (up to `hops`) and return every
 * Location seen — so a second hop the app itself adds (path normalisation of
 * `//evil.example`, for one) is checked too, not only the first.
 */
export async function redirectChain(
  ctx: APIRequestContext,
  first: string | undefined,
  hops = 5,
): Promise<string[]> {
  const seen: string[] = [];
  let next = first;
  while (next && seen.length < hops) {
    seen.push(next);
    if (!sameOrigin(next)) break;
    const res = await ctx.get(new URL(next, BASE_URL).toString(), { maxRedirects: 0 });
    next = res.status() >= 300 && res.status() < 400 ? res.headers()["location"] : undefined;
  }
  return seen;
}

/** True when `location` (a redirect target) stays on the app's own origin. */
export function sameOrigin(location: string | undefined | null): boolean {
  if (!location) return true; // no redirect at all leaves the user where they are
  try {
    return new URL(location, BASE_URL).origin === new URL(BASE_URL).origin;
  } catch {
    return false;
  }
}
