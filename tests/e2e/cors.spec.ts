// CORS against the served app (app-business-core issue 742; Matt Murphy items
// 14, 68, 220): "Test approved and unapproved origins with and without cookies
// to confirm that only trusted sites can make authenticated requests and read
// responses." Request-only: runs without a browser.
//
// The approved origin is the app's own canonical origin (locally the request's
// own origin, http://localhost:3000); config/cors.ts lists no other. A browser
// lets a page read a cross-origin response only when Access-Control-Allow-Origin
// names that page's origin — so "cannot read" is "no such header".

import { test, expect, type APIRequestContext } from "@playwright/test";
import { addressFor, uniqueEmail } from "../support/browser";
import { BASE_URL, client, ensureAccount, signIn } from "./session-helpers";

const APPROVED = new URL(BASE_URL).origin;
const UNAPPROVED = [
  "https://evil.example",
  "null",
  `${APPROVED}.evil.example`,
  "http://127.0.0.1:3000",
  APPROVED.toUpperCase(),
];
// One account per run of this file, made in beforeAll and only read by the tests
// (they sign it in; none changes it). Unique per run and per retry (issue 740).
let EMAIL = "";
// Its own client address per test (issue 740): no test spends another's sign-in budget.
const address = () => addressFor(test.info());

let signedIn: APIRequestContext;
let anonymous: APIRequestContext;

test.beforeAll(async () => {
  EMAIL = uniqueEmail(test.info(), "cors-742");
  anonymous = await client(address());
  await ensureAccount(anonymous, EMAIL);
  const token = await signIn(await client(address()), EMAIL);
  signedIn = await client(address(), token);
});

test.afterAll(async () => {
  await signedIn?.dispose();
  await anonymous?.dispose();
});

for (const withCookie of [true, false]) {
  const label = withCookie ? "with the session cookie" : "without cookies";

  test(`approved origin ${label}: allowed, credentials only for that exact origin`, async () => {
    const ctx = withCookie ? signedIn : anonymous;
    for (const path of ["/api/tenant", "/dashboard", "/api/health"]) {
      const res = await ctx.get(path, { headers: { origin: APPROVED }, maxRedirects: 0 });
      const h = res.headers();
      expect(h["access-control-allow-origin"], path).toBe(APPROVED);
      expect(h["access-control-allow-credentials"], path).toBe("true");
      // Vary: Origin keeps a shared cache from handing one origin's answer to
      // another. Next.js 15 replaces the middleware's Vary on a page it renders
      // itself (build/templates/app-page.js sets its own), so a rendered page
      // must instead be one no cache may store at all.
      if (!/origin/i.test(h["vary"] ?? "")) {
        expect(res.status(), path).toBe(200);
        expect(h["cache-control"] ?? "", `${path} has no Vary: Origin, so it must be no-store`).toMatch(/no-store/);
      }
    }
  });

  test(`unapproved origins ${label}: no CORS header, so the response cannot be read`, async () => {
    const ctx = withCookie ? signedIn : anonymous;
    for (const origin of UNAPPROVED) {
      for (const path of ["/api/tenant", "/dashboard", "/api/health"]) {
        const res = await ctx.get(path, { headers: { origin }, maxRedirects: 0 });
        const h = res.headers();
        expect(h["access-control-allow-origin"], `${origin} ${path}`).toBeUndefined();
        expect(h["access-control-allow-credentials"], `${origin} ${path}`).toBeUndefined();
      }
    }
  });
}

test("the signed-in read really is authenticated, so the header test means something", async () => {
  const res = await signedIn.get("/dashboard", { headers: { origin: APPROVED }, maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const anon = await anonymous.get("/dashboard", { headers: { origin: APPROVED }, maxRedirects: 0 });
  expect(anon.status()).toBe(307);
});

test("preflight: approved origin 204 with credentials, unapproved 403 with nothing", async () => {
  const ok = await anonymous.fetch("/api/tenant", {
    method: "OPTIONS",
    headers: { origin: APPROVED, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  expect(ok.status()).toBe(204);
  expect(ok.headers()["access-control-allow-origin"]).toBe(APPROVED);
  expect(ok.headers()["access-control-allow-credentials"]).toBe("true");
  expect(ok.headers()["access-control-allow-methods"]).toMatch(/POST/);

  for (const origin of UNAPPROVED) {
    const no = await anonymous.fetch("/api/tenant", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
    expect(no.status(), origin).toBe(403);
    expect(no.headers()["access-control-allow-origin"], origin).toBeUndefined();
  }
});

test("never a wildcard, never the caller's Origin reflected", async () => {
  const res = await signedIn.get("/api/health", { headers: { origin: "https://reflect-me.example" } });
  const all = JSON.stringify(res.headers());
  expect(all).not.toContain("reflect-me.example");
  expect(res.headers()["access-control-allow-origin"]).not.toBe("*");
});
