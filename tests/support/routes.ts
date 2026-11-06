// Every page the app serves, ONE list, read by the accessibility suite
// (tests/a11y/a11y.spec.ts) and held complete by tests/unit/browser-suite-coverage.test.ts
// (app-business-core issue 720; Matt Murphy #117: "audit every interactive element",
// "every image every button every input every navigation element").
//
// Discovery walks `app/` for page files, so a page an app adds is found the next time
// the coverage test runs; the coverage test then fails until the page is listed here.
// Listing it is one line: where to visit it, and whether it is visited signed out too.
// Nothing is skipped silently: a page that cannot be visited says why in `skip`.

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type PageRoute = {
  /** The address to visit (with any query string the page needs to render its form). */
  visit: string;
  /** Also visited signed out (a public page). Every page is visited signed in. */
  signedOut: boolean;
  /** Why the page is not visited, when it cannot be. */
  skip?: string;
};

// A shape-valid reset token (lib/validation/input.ts tokenField), so the page renders
// its form. It matches no real reset, which the page only finds out on submit.
const SAMPLE_TOKEN = "browser-suite-sample-token-0000";

export const PAGE_ROUTES: Record<string, PageRoute> = {
  "/": { visit: "/", signedOut: true },
  "/account": { visit: "/account", signedOut: false },
  "/account-closed": { visit: "/account-closed", signedOut: true },
  "/account/privacy": { visit: "/account/privacy", signedOut: false },
  "/account/security": { visit: "/account/security", signedOut: false },
  "/contact": { visit: "/contact", signedOut: true },
  "/crash-check": {
    visit: "/crash-check",
    signedOut: true,
    skip:
      "A test-only page (E2E_CRASH_ROUTE=1) that crashes on purpose and answers 500; its crash " +
      "screen is checked with axe, signed out, by tests/e2e/safety-net.spec.ts.",
  },
  "/dashboard": { visit: "/dashboard", signedOut: false },
  "/dashboard/settings": { visit: "/dashboard/settings", signedOut: false },
  "/legal/dpa": { visit: "/legal/dpa", signedOut: true },
  "/legal/service-agreement": { visit: "/legal/service-agreement", signedOut: true },
  "/login": { visit: "/login", signedOut: true },
  "/privacy": { visit: "/privacy", signedOut: true },
  "/reactivate": { visit: "/reactivate", signedOut: false },
  "/refund-policy": { visit: "/refund-policy", signedOut: true },
  "/reset-password": { visit: `/reset-password?token=${SAMPLE_TOKEN}`, signedOut: true },
  "/security": { visit: "/security", signedOut: true },
  "/sessions/revoke": { visit: `/sessions/revoke?t=${SAMPLE_TOKEN}`, signedOut: true },
  "/signup": { visit: "/signup", signedOut: true },
  "/subprocessors": { visit: "/subprocessors", signedOut: true },
  "/terms": { visit: "/terms", signedOut: true },
};

/** Every page route under `app/`, as the address Next.js serves it at. */
export function discoverPageRoutes(appDir = join(process.cwd(), "app")): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Private folders (_x) are never routes; api/ holds handlers, not pages.
        if (entry.name.startsWith("_") || (dir === appDir && entry.name === "api")) continue;
        walk(full);
      } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(entry.name)) {
        const segments = relative(appDir, dir)
          .split(sep)
          .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
        out.push("/" + segments.join("/"));
      }
    }
  };
  walk(appDir);
  return out.sort();
}

/** The routes to visit, in a stable order. */
export function visitedRoutes(): Array<[string, PageRoute]> {
  return Object.entries(PAGE_ROUTES)
    .filter(([, r]) => !r.skip)
    .sort(([a], [b]) => a.localeCompare(b));
}
