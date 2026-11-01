// Anonymous access to protected routes must not obtain a database handle —
// they redirect or return 401. Both tenancy modes rely on this floor: if a
// request without a session can reach data-fetching code, nothing downstream
// matters. This spec runs against the standard house-starter shell today
// (protected /dashboard route) and stays in place unchanged per app.

import { expect, test } from "@playwright/test";
import { appDir, attackableRoutes } from "./route-map";
import { BASE_URL, client, mintToken } from "../e2e/session-helpers";

const PROTECTED_ROUTES = ["/dashboard"];

for (const route of PROTECTED_ROUTES) {
  test(`anonymous GET ${route} must not obtain a DB handle`, async ({ page, context }) => {
    await context.clearCookies();
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });

    if (!response) {
      throw new Error(`no response for ${route}`);
    }

    // Two acceptable outcomes for a data-protecting boundary:
    //   1. HTTP 401 / 403 (route returned without a session)
    //   2. Redirect to the login screen — the final URL is /login (Next may
    //      preserve the query, e.g. ?callbackUrl=/dashboard).
    const status = response.status();
    const url = new URL(page.url());

    const okRedirect = url.pathname === "/login";
    const okStatus = status === 401 || status === 403;

    expect(okRedirect || okStatus, {
      message:
        `Expected anonymous ${route} to redirect to /login or return 401/403; ` +
        `got ${status} at ${url.pathname}`,
    }).toBe(true);
  });
}

// ── #516 (Matt Murphy #33): anonymous and forged/expired-cookie requests to
// every route in the route map, plus trailing-slash, double-slash, encoded and
// case variants; must never return data. API level (no browser), so it runs
// wherever the app runs. The forged cookies are the #798 set: modified, expired,
// wrongly issued (another secret) and unsigned. Source-level twin, which fails
// when one route's own auth check is deleted:
// tests/unit/route-session-check.test.ts.

const SWEEP_ADDRESS = "203.0.113.16";
const SWEEP_ROUTES = attackableRoutes(appDir()).filter((r) => r.params.length === 0);

/** The path itself and the variants a matcher can miss. */
function variants(path: string): string[] {
  const [, first, ...rest] = path.split("/");
  const encodedFirst = `%${first.charCodeAt(0).toString(16)}${first.slice(1)}`;
  return [
    path,
    `${path}/`,
    `/${path}`,
    `${path}//`,
    ["", encodedFirst, ...rest].join("/"),
    path.toUpperCase(),
    path.replace(/\/([a-z])/, (_m, c: string) => `/${c.toUpperCase()}`),
  ];
}

async function forgedCookies(): Promise<Array<[string, string | undefined]>> {
  const claims = {
    id: "forged-user",
    sub: "forged-user",
    role: "owner",
    tenantId: "forged-tenant",
    sessionId: "forged-session",
  };
  const valid = await mintToken(claims);
  const i = Math.floor(valid.length / 2);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [
    ["no cookie", undefined],
    ["modified token", valid.slice(0, i) + (valid[i] === "A" ? "B" : "A") + valid.slice(i + 1)],
    ["expired token", await mintToken(claims, { maxAge: -3600 })],
    ["wrongly issued token", await mintToken(claims, { secret: "another-apps-secret" })],
    [
      "unsigned token",
      `${b64({ alg: "none", typ: "JWT" })}.${b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 })}.`,
    ],
  ];
}

/** A response that returned no data: refused, absent, or sent to sign in. */
function refused(status: number, finalPath: string): boolean {
  return finalPath === "/login" || [401, 403, 404, 405].includes(status);
}

test.describe("#516 anonymous and forged-cookie sweep", () => {
  test("the sweep has routes to cover", () => {
    expect(SWEEP_ROUTES.map((r) => r.path)).toEqual(
      expect.arrayContaining(["/account", "/dashboard", "/api/tenant"]),
    );
  });

  for (const route of SWEEP_ROUTES) {
    test(`${route.path}: every variant, every bad cookie, never data`, async () => {
      const failures: string[] = [];
      for (const [label, cookie] of await forgedCookies()) {
        const ctx = await client(SWEEP_ADDRESS, cookie);
        for (const path of variants(route.path)) {
          const res = await ctx.get(`${BASE_URL}${path}`);
          const finalPath = new URL(res.url()).pathname;
          if (!refused(res.status(), finalPath)) {
            failures.push(`GET ${path} with ${label} → ${res.status()} at ${finalPath}`);
          }
        }
        for (const method of route.methods.filter((m) => m !== "GET" && m !== "HEAD")) {
          const res = await ctx.fetch(`${BASE_URL}${route.path}`, { method, data: {} });
          if (!refused(res.status(), new URL(res.url()).pathname)) {
            failures.push(`${method} ${route.path} with ${label} → ${res.status()}`);
          }
        }
        await ctx.dispose();
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});
