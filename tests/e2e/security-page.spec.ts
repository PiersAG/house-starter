// The public security page, security.txt and the CSP report endpoint, served
// by the built app (app-business-core issues 524 and 446). Request-only: runs
// without a browser.

import { test, expect } from "@playwright/test";
import { addressFor } from "../support/browser";

test("/security is public and covers every topic buyers check", async ({ request }) => {
  const res = await request.get("/security", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const html = await res.text();
  for (const id of ["encryption", "isolation", "scanning", "incidents", "data-location", "backups", "report"]) {
    expect(html, id).toContain(`id="${id}"`);
  }
  expect(html).toContain("Report a security problem");
});

test("/.well-known/security.txt follows RFC 9116", async ({ request }) => {
  const res = await request.get("/.well-known/security.txt", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
  const txt = await res.text();
  expect(txt).toMatch(/^Contact: (mailto:\S+@\S+|https?:\/\/\S+)$/m);
  const expires = /^Expires: (\S+)$/m.exec(txt)?.[1] ?? "";
  const ms = Date.parse(expires) - Date.now();
  expect(ms).toBeGreaterThan(0);
  expect(ms).toBeLessThan(365 * 24 * 60 * 60 * 1000);
  expect(txt).toMatch(/^Policy: \S+\/security#report$/m);
  expect(txt).toMatch(/^Canonical: \S+\/\.well-known\/security\.txt$/m);
});

test("security.txt never takes its address from a forged Host header", async ({ request }) => {
  const res = await request.get("/.well-known/security.txt", {
    headers: { "x-forwarded-host": "attacker.example" },
  });
  expect(await res.text()).not.toContain("attacker.example");
});

test("/api/csp-report accepts both report formats and answers 204", async ({ request }) => {
  const legacy = await request.post("/api/csp-report", {
    headers: { "content-type": "application/csp-report", "x-forwarded-for": addressFor(test.info(), "71") },
    data: JSON.stringify({
      "csp-report": {
        "document-uri": "http://localhost:3000/login?x=1",
        "effective-directive": "script-src-elem",
        "blocked-uri": "https://cdn.evil.example/x.js",
        disposition: "enforce",
      },
    }),
  });
  expect(legacy.status()).toBe(204);
  const modern = await request.post("/api/csp-report", {
    headers: { "content-type": "application/reports+json", "x-forwarded-for": addressFor(test.info(), "71") },
    data: JSON.stringify([
      { type: "csp-violation", body: { documentURL: "http://localhost:3000/", effectiveDirective: "img-src", blockedURL: "data" } },
    ]),
  });
  expect(modern.status()).toBe(204);
});

test("/api/csp-report says nothing to junk or an oversized body", async ({ request }) => {
  for (const data of ["not json", JSON.stringify({ hello: "world" }), "x".repeat(20 * 1024)]) {
    const res = await request.post("/api/csp-report", {
      headers: { "content-type": "application/json", "x-forwarded-for": addressFor(test.info(), "72") },
      data,
    });
    expect(res.status()).toBe(204);
    expect(await res.text()).toBe("");
  }
});
