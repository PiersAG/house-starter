import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}", "app/**/*.{test,spec}.{ts,tsx}", "lib/**/*.{test,spec}.{ts,tsx}", "components/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["app/**", "components/**", "lib/**"],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        // Server actions tested via E2E, not unit tests:
        "app/**/actions.ts",
        "app/api/**",
        // Server components and page shells — tested via Playwright E2E:
        "app/**/page.tsx",
        "app/**/layout.tsx",
        "app/**/LoginForm.tsx",
        // UI primitive components — tested via E2E accessibility scans:
        "components/ui/**",
      ],
      // SECURITY GATE (spec C4b): per-file 100% thresholds on the
      // security-critical modules. This is the real gate — enforced here,
      // where coverage is actually computed, on real files named by path.
      // There are deliberately NO blanket global thresholds: the rest of the
      // report is informational and must stay truthful, not aspirational.
      thresholds: {
        // The tenant-role decision (finding 1). An uncovered branch here is a
        // path where "signed in" silently becomes "allowed" — the exact shape of
        // the defect this file was written to close.
        "**/lib/authz.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // The control plane's read/write primitives. An uncovered branch is a
        // path by which an operator value is read from, or written to, the wrong
        // database — and an operator value in a tenant database is invisible to
        // the app that is supposed to obey it.
        "**/lib/settings/operator.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/password.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/rate-limit.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // The auth-throttling seam (SEC.42). lib/rate-limit.ts decides HOW a
        // limit is counted; this decides WHICH surfaces are limited and whether
        // a surface and its API twin share one budget. An uncovered branch here
        // is an unlimited door.
        "**/lib/auth-rate-limit.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // Where links the app SENDS OUT get their domain. An uncovered branch
        // is a path that could fall back to the caller's Host header, which is
        // how a password-reset link ends up pointing at an attacker.
        "**/lib/app-url.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/users.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/db.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // The other two halves of the ADR-023 routing seam. lib/db.ts decides
        // WHICH database; lib/catalog.ts decides where identity is read from,
        // and lib/tenant-context.ts decides whether this request has a tenant at
        // all. An uncovered branch in either is an untested answer to "whose
        // data is this?", which is the same class of gap as an uncovered branch
        // in the resolver itself.
        "**/lib/catalog.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/tenant-context.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
