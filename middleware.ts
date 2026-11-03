// Edge middleware: nonce-based Content-Security-Policy, CORS + route protection.
//
// A fresh nonce is generated per request and injected into both the CSP
// `script-src` directive and (by Next.js, which reads the request CSP header)
// the framework's own <script> tags. There is no 'unsafe-inline' in
// script-src — every script must carry the per-request nonce. The policy, its
// violation reporting and its report-only phase live in lib/csp.ts
// (PiersAG/app-business-core#446).
//
// CORS runs in the same pass (lib/cors.ts, #742): a preflight from an origin
// on the allowlist is answered here, any other preflight is refused, and every
// response carries CORS headers only for an allowlisted Origin.
//
// Route protection runs in the same pass: an unauthenticated request to a
// protected prefix is redirected to /login. The dashboard page repeats the
// check server-side as defence in depth.
//
// Request id (PiersAG/app-business-core#503): every request gets a fresh
// x-request-id here — on the request passed on (so the route's log line and any
// error row carry it) and on every response (so the browser and support can
// quote it). A caller-sent x-request-id is replaced, never trusted.

import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { decideAccess, currentLifecycleState } from "@/lib/live-eval";
import { isPathDisabledByCapability } from "@/lib/capabilities/routes";
import { isPathDisabledByBilling } from "@/lib/billing/routes";
import { applyCsp, generateNonce } from "@/lib/csp";
import { allowedOrigins, applyCors, corsPreflight, isPreflight } from "@/lib/cors";
import { REQUEST_ID_HEADER, newRequestId } from "@/lib/observability/request-id";

const { auth } = NextAuth(authConfig);

const PROTECTED_PREFIXES = ["/dashboard"];

export default auth((req) => {
  const nonce = generateNonce();
  const requestId = newRequestId();
  const { pathname } = req.nextUrl;
  const origin = req.headers.get("origin");
  const allowed = allowedOrigins(undefined, req.nextUrl.origin);

  // Every response leaves through here: the CSP headers and, for an
  // allowlisted Origin only, the CORS headers.
  const finish = (res: NextResponse): NextResponse => {
    applyCsp(res.headers, nonce);
    applyCors(res.headers, origin, allowed);
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return res;
  };

  // CORS preflight (#742): answered before anything else, so an unlisted
  // origin is refused the same way on every path.
  if (isPreflight(req.method, req.headers)) {
    const pf = corsPreflight(origin, allowed);
    const res = new NextResponse(null, { status: pf.status, headers: pf.headers });
    applyCsp(res.headers, nonce);
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return res;
  }

  // Capability R2 enforcement (steps 7–9): a request under an OFF capability's
  // registered route prefix (lib/capabilities/routes.ts) is answered 404 — the
  // surface is ABSENT, not forbidden — before auth or anything else runs, so an
  // off capability looks identical to a route that was never built, to any
  // caller. A core/kernel path returns false here and falls through untouched.
  if (isPathDisabledByCapability(pathname)) {
    return finish(NextResponse.json({ error: "Not found." }, { status: 404 }));
  }

  // Subscription-billing ACTIVE switch (capability-model-spec §2.1). The
  // subscription surface is KERNEL — it ships in every app — but an app whose
  // commission declared NO SUBSCRIPTION has no price to charge against, so its
  // billing routes must be INERT rather than live-but-unconfigured. Same
  // treatment as an off capability: 404 before auth or anything else runs, so no
  // request can reach a Stripe call. Active apps (the default) fall through
  // untouched. Handlers repeat the check as defence in depth.
  if (isPathDisabledByBilling(pathname)) {
    return finish(NextResponse.json({ error: "Not found." }, { status: 404 }));
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (isProtected && !req.auth) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    // Back to this page after signing in again (issue 525); the sign-in page and
    // action accept only a local path (lib/session/return-path.ts).
    loginUrl.searchParams.set("callbackUrl", `${pathname}${req.nextUrl.search}`);
    return finish(NextResponse.redirect(loginUrl));
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
      return finish(
        NextResponse.json(
          {
            error:            "forbidden",
            reason:           decision.reason,
            lifecycle_state:  state,
          },
          { status: 403 },
        ),
      );
    }
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  applyCsp(requestHeaders, nonce);

  return finish(NextResponse.next({ request: { headers: requestHeaders } }));
});

export const config = {
  // Run on every page request to apply the CSP, but skip Next's static assets
  // and image optimiser so their caching is unaffected.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
