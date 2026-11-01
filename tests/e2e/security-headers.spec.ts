// Security headers on real responses (app-business-core issue 446, ASVS V14.4).
//
// Read off the built and served app, not from the config, because headers can
// be set in several places and a response the middleware builds itself (a
// redirect, a 404, a refusal) must carry them too — the residual the factory's
// scan check left open. Request-only: runs without a browser.

import { test, expect } from "@playwright/test";

const PATHS = [
  { path: "/", why: "home page" },
  { path: "/login", why: "sign-in page" },
  { path: "/security", why: "security page" },
  { path: "/dashboard", why: "middleware redirect to sign-in" },
  { path: "/no-such-page-s11", why: "not found" },
  { path: "/api/health", why: "API route" },
];

for (const { path, why } of PATHS) {
  test(`${path} (${why}) carries every required security header`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    const h = res.headers();
    expect(h["x-content-type-options"], "nosniff").toBe("nosniff");
    expect(h["x-frame-options"], "anti-framing").toBe("DENY");
    expect(h["referrer-policy"]).toMatch(/^(no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin)$/);
    const hsts = h["strict-transport-security"] ?? "";
    expect(Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0)).toBeGreaterThanOrEqual(15724800);
    expect(hsts).toMatch(/includeSubDomains/);
    expect(h["permissions-policy"]).toMatch(/camera=\(\)/);
    if (path !== "/api/health") {
      const csp = h["content-security-policy"] ?? "";
      expect(csp, "CSP").toMatch(/frame-ancestors 'none'/);
      expect(csp).toMatch(/object-src 'none'/);
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    }
  });
}
