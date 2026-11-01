// CSP violation reporting on real responses (app-business-core issue 446,
// Matt Murphy item 165): every policy the app sends — on pages and on the
// responses the middleware builds itself — names the report endpoint, and no
// report-only policy is sent while config/csp.ts has nothing report-only.
// Request-only: runs without a browser.

import { test, expect } from "@playwright/test";
import { CSP_SOURCES } from "@/config/csp";

const PATHS = ["/", "/login", "/security", "/dashboard", "/no-such-page-s11"];

for (const path of PATHS) {
  test(`${path}: the policy reports violations to /api/csp-report`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    const h = res.headers();
    expect(h["content-security-policy"]).toMatch(/report-uri \/api\/csp-report/);
    expect(h["content-security-policy"]).toMatch(/report-to csp-endpoint/);
    expect(h["reporting-endpoints"]).toBe('csp-endpoint="/api/csp-report"');
    const reportOnly = CSP_SOURCES.some((s) => !s.enforcedOn);
    if (reportOnly) {
      expect(h["content-security-policy-report-only"]).toMatch(/report-uri \/api\/csp-report/);
    } else {
      expect(h["content-security-policy-report-only"]).toBeUndefined();
    }
  });
}

test("the page's scripts still carry the enforced policy's nonce", async ({ request }) => {
  const res = await request.get("/login");
  const nonce = /'nonce-([^']+)'/.exec(res.headers()["content-security-policy"] ?? "")?.[1];
  expect(nonce).toBeTruthy();
  expect(await res.text()).toContain(`nonce="${nonce}"`);
});
