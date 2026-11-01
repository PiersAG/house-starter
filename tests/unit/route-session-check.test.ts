// Every protected route checks the session itself (PiersAG/app-business-core
// #516, Matt Murphy #33: "middleware matchers miss paths and path variants
// bypass checks"). Acceptance: deleting one route's auth check fails the suite.
//
// Defence in depth is the design: the middleware guards only the /dashboard
// prefix (middleware.ts PROTECTED_PREFIXES), and every other protected page and
// API handler — /account, /api/tenant, /api/settings/[key], billing — relies on
// its OWN server-side `auth()` call. A request that slips past the middleware
// (an encoded or differently-cased path, a matcher gap) still meets that call.
// So the check that matters is source-level: every route the isolation suite
// treats as protected (tests/isolation/route-map.ts attackableRoutes — every
// route except `/` and the declared public prefixes, each with its reason) must
// call `auth()` in the file that answers it. The HTTP sweep over the same routes,
// with path variants and forged cookies, is tests/isolation/anon.spec.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appDir, attackableRoutes } from "../isolation/route-map";

/** True when the source reads the server-side session (comments ignored). */
function callsAuth(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return /\bawait\s+auth\s*\(\s*\)/.test(code);
}

const ROUTES = attackableRoutes(appDir());

describe("#516 every protected route checks the session itself", () => {
  it("finds the protected routes (the guard is not vacuous)", () => {
    const paths = ROUTES.map((r) => r.path);
    for (const p of ["/account", "/dashboard", "/api/tenant", "/api/settings/[key]"]) {
      expect(paths).toContain(p);
    }
  });

  for (const route of ROUTES) {
    it(`${route.path} (${route.kind}) calls auth()`, () => {
      expect(
        callsAuth(readFileSync(route.source, "utf8")),
        `${route.source} answers a protected route but never calls auth() — ` +
          "add the session check, or declare the route public in " +
          "tests/isolation/route-map.ts ROUTE_EXCLUSIONS with its reason",
      ).toBe(true);
    });
  }

  it("negative control: the same route with its check deleted fails the guard", () => {
    const tenant = ROUTES.find((r) => r.path === "/api/tenant")!;
    const source = readFileSync(tenant.source, "utf8");
    expect(callsAuth(source)).toBe(true);
    expect(callsAuth(source.replace(/await\s+auth\s*\(\s*\)/g, "null"))).toBe(false);
    // A commented-out check does not count.
    expect(callsAuth("// const s = await auth();\nexport async function GET() {}")).toBe(false);
  });
});
