// Injection probe against every route that takes query or route input
// (PiersAG/app-business-core #517; Matt Murphy #42: "Submit crafted strings and
// boundary-length values to each affected route and verify that the query
// remains parameterized and unauthorised records are never returned").
//
// THE TARGETS ARE DISCOVERED, not listed: every route under app/ with a dynamic
// segment, and every route or page whose source reads query input
// (searchParams). A route the builder adds is probed the next time this runs.
//
// THE PROBE. Signed in as account A, each target gets crafted strings (SQL,
// path traversal, null bytes, markup) and boundary-length values in every route
// parameter and every query key its source names. Each answer must be a
// refusal or an ordinary page — never a server error, never a database error
// or stack trace — and must never contain account B's record (B's address, a
// value unique to this run), so "unauthorised records are never returned" is
// checked by looking for it; a valid write by A before and after proves the
// route works at all (a route that failed every request would "leak nothing").
//
// API-level (no browser), like the other request-level specs.

import { expect, test } from "@playwright/test";
import { addressFor } from "../support/browser";
import { readFileSync } from "node:fs";
import { appDir, discoverAllRoutes, type DiscoveredRoute } from "../isolation/route-map";
import { client, ensureAccount, signIn, writeHeaders } from "./session-helpers";

const CRAFTED = [
  "' OR '1'='1",
  "1; DROP TABLE users;--",
  "\" OR \"\"=\"",
  "') UNION SELECT * FROM users--",
  "%27%20OR%201%3D1--",
  "../../../../etc/passwd",
  "..%2F..%2Fetc%2Fpasswd",
  "\u0000",
  "<script>alert(1)</script>",
  "${7*7}",
  "x".repeat(2_048),
  "x".repeat(10_000),
  "",
];

const DB_ERRORS = /SQLITE|LibsqlError|syntax error|no such (table|column)|unrecognized token|at .+\.(ts|js):\d+/i;

/** Query keys a route's source names (searchParams.get("k") and query schemas). */
function queryKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/searchParams\.get\(\s*["'](\w+)["']/g)) keys.add(m[1]);
  for (const m of source.matchAll(/[qQ]uery\w*Schema\s*=\s*z\.object\(\{([^}]*)\}/g)) {
    for (const k of m[1].matchAll(/(\w+)\s*:/g)) keys.add(k[1]);
  }
  return [...keys];
}

function takesInput(route: DiscoveredRoute): boolean {
  if (route.path.startsWith("/api/auth")) return false; // the sign-in kernel: probed by the S8 specs
  return route.params.length > 0 || /searchParams/.test(readFileSync(route.source, "utf8"));
}

const TARGETS = discoverAllRoutes(appDir()).filter(takesInput);

function urlFor(route: DiscoveredRoute, value: string, keys: string[]): string {
  let path = route.path;
  for (const p of route.params) path = path.replace(`[${p}]`, encodeURIComponent(value));
  const qs = new URLSearchParams();
  for (const k of keys) qs.set(k, value);
  const q = qs.toString();
  return `${path}${q ? `?${q}` : ""}`;
}

test.describe("injection probe — every route that takes query or route input (#517)", () => {
  test("the targets were found", () => {
    // The template has two: the settings route (key, scope) and the reset page (token).
    expect(TARGETS.map((t) => t.path)).toEqual(expect.arrayContaining(["/api/settings/[key]", "/reset-password"]));
  });

  test("crafted and boundary-length values are refused, never leak, never break the query", async () => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const a = await client(addressFor(test.info(), "71"));
    const b = await client(addressFor(test.info(), "72"));
    const emailA = `probe-a-${stamp}@example.com`;
    const emailB = `probe-b-${stamp}@example.com`;
    await ensureAccount(a, emailA);
    await ensureAccount(b, emailB);
    await signIn(a, emailA);
    await signIn(b, emailB);

    // B's record, which A must never see (B's own account: its address), and a
    // valid write by A, which proves the route works — so the refusals below
    // are refusals, not a broken route.
    const sentinelB = emailB;
    const headers = await writeHeaders(a);
    const putA = await a.put("/api/settings/core.client_self_registration", { data: { value: true }, headers });
    expect(putA.status(), await putA.text()).toBe(200);

    for (const route of TARGETS) {
      const keys = queryKeys(readFileSync(route.source, "utf8"));
      const methods = route.kind === "api" ? route.methods.filter((m) => m !== "OPTIONS" && m !== "HEAD") : ["GET"];
      for (const value of CRAFTED) {
        const url = urlFor(route, value, keys);
        for (const method of methods) {
          const res = await a.fetch(url, {
            method,
            headers,
            data: method === "PUT" || method === "POST" || method === "PATCH" ? { value: "probe" } : undefined,
            maxRedirects: 0,
          });
          const body = await res.text();
          const where = `${method} ${route.path} with ${JSON.stringify(value.slice(0, 40))}`;
          expect(res.status(), where).toBeLessThan(500);
          expect(body, where).not.toMatch(DB_ERRORS);
          expect(body, where).not.toContain(sentinelB);
          if (value.includes("<script>")) expect(body, where).not.toContain(value);
        }
      }
    }

    // Still working for A afterwards, and B's record never appeared.
    const again = await a.put("/api/settings/core.client_self_registration", { data: { value: false }, headers });
    expect(again.status()).toBe(200);
    const page = await a.get("/dashboard/settings");
    expect(page.status()).toBe(200);
    expect(await page.text()).not.toContain(sentinelB);
  });
});
