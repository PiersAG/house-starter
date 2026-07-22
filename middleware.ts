// Edge middleware: nonce-based Content-Security-Policy + route protection.
//
// A fresh nonce is generated per request and injected into both the CSP
// `script-src` directive and (by Next.js, which reads the request CSP header)
// the framework's own <script> tags. There is no 'unsafe-inline' in
// script-src — every script must carry the per-request nonce.
//
// Route protection runs in the same pass: an unauthenticated request to a
// protected prefix is redirected to /login. The dashboard page repeats the
// check server-side as defence in depth.

import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { decideAccess, currentLifecycleState } from "@/lib/live-eval";
import { isPathDisabledByCapability } from "@/lib/capabilities/routes";

const { auth } = NextAuth(authConfig);

const PROTECTED_PREFIXES = ["/dashboard"];

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    // Nonce-based script-src — no 'unsafe-inline'. 'strict-dynamic' lets
    // Next.js's nonce'd bootstrap script load its own chunks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Styles may be inlined by Next.js/Tailwind; the baseline only requires a
    // nonce on scripts.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export default auth((req) => {
  const nonce = generateNonce();
  const csp = buildCsp(nonce);
  const { pathname } = req.nextUrl;

  // Capability R2 enforcement (steps 7–9): a request under an OFF capability's
  // registered route prefix (lib/capabilities/routes.ts) is answered 404 — the
  // surface is ABSENT, not forbidden — before auth or anything else runs, so an
  // off capability looks identical to a route that was never built, to any
  // caller. A core/kernel path returns false here and falls through untouched.
  if (isPathDisabledByCapability(pathname)) {
    const notFound = NextResponse.json({ error: "Not found." }, { status: 404 });
    notFound.headers.set("Content-Security-Policy", csp);
    return notFound;
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (isProtected && !req.auth) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    const redirectRes = NextResponse.redirect(loginUrl);
    redirectRes.headers.set("Content-Security-Policy", csp);
    return redirectRes;
  }

  // ADR-026 D4 — LIVE-EVAL evaluator allowlist. When the app is in
  // LIVE_EVAL (env APP_LIFECYCLE_STATE), an authenticated user must be on
  // the allowlist (or be the CEO) to access a protected route. LIVE_OPEN
  // and LAUNCHED (live-quiet) skip this check. LIVE_EVAL with an empty
  // allowlist is a fail-closed configuration: no-one but the CEO passes.
  if (isProtected && req.auth) {
    const email = (req.auth.user as { email?: string } | undefined)?.email ?? null;
    const decision = decideAccess(email);
    if (!decision.allow) {
      const state = currentLifecycleState();
      const forbidden = NextResponse.json(
        {
          error:            "forbidden",
          reason:           decision.reason,
          lifecycle_state:  state,
        },
        { status: 403 },
      );
      forbidden.headers.set("Content-Security-Policy", csp);
      return forbidden;
    }
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
});

export const config = {
  // Run on every page request to apply the CSP, but skip Next's static assets
  // and image optimiser so their caching is unaffected.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
