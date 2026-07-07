// Anonymous access to protected routes must not obtain a database handle —
// they redirect or return 401. Both tenancy modes rely on this floor: if a
// request without a session can reach data-fetching code, nothing downstream
// matters. This spec runs against the standard house-starter shell today
// (protected /dashboard route) and stays in place unchanged per app.

import { expect, test } from "@playwright/test";

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
