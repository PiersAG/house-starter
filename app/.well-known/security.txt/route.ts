// GET /.well-known/security.txt — RFC 9116 (app-business-core issue 524,
// Matt Murphy item 151): who to tell about a security problem, and the policy.
//
// Built per request so `Expires` is always in the future. Links use the
// server-side canonical URL (lib/app-url.ts), never the caller's Host header.
//
// Verified via E2E (tests/e2e/security-page.spec.ts); the text builder is
// unit-tested in tests/unit/security-page.test.ts.

import { canonicalBaseUrl } from "@/lib/app-url";
import { buildSecurityTxt, securityContact } from "@/lib/security-page";
import { withRouteLimit } from "@/lib/abuse/route-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function securityTxt(request: Request): Response {
  const base = canonicalBaseUrl(undefined, new URL(request.url).origin);
  return new Response(buildSecurityTxt(base, securityContact()), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

// The route limit (app-business-core issue 787): a public endpoint, so the public budget.
export const GET = withRouteLimit("public.security-txt", securityTxt);
