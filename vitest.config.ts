import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // Every route now runs the route limit (lib/abuse/route-limit.ts,
    // app-business-core #787), so a test that calls a route handler needs a
    // store: the safe-environment in-memory stand-in, as in CI's e2e runs. Tests
    // of the "not configured" refusal pass their own env objects.
    env: { RATE_LIMIT_ALLOW_IN_MEMORY: "true" },
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
        // CSP, CORS and the public security page (app-business-core S11: #446,
        // #742, #524). An uncovered branch in lib/cors.ts is a path that could
        // hand another website a signed-in user's data; in lib/csp.ts, a page
        // sent without its policy or its violation reporting.
        "**/lib/cors.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/csp.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/csp-report.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/security-page.ts": {
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
        // SEC.15 MFA (Slice 1). The second factor's whole security story lives
        // in these files: the at-rest seal on TOTP secrets, the code check
        // and its single-use step, recovery-code generation and hashing, and the
        // catalog reads/writes that enforce single use, the failure ceiling and
        // the anti-lockout rule. An uncovered branch in any of them is an
        // untested way to pass a second factor without holding it.
        "**/lib/crypto/secret-box.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/mfa/totp.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/mfa/recovery-codes.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/mfa/enrollment.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/mfa/sign-in.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // The one gate in front of every /api/auth/mfa/* route: session, then
        // rate limit (per client AND per account), then input. An uncovered
        // branch is a route that can be reached without one of the three.
        "**/lib/mfa/route-guard.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // The one "get key" layer (#822 Step 5). An uncovered branch is a path
        // where a moved key could quietly fall back to its old stored copy, or
        // a value could reach an error message.
        "**/lib/vault.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // Bundle S4 (keys inside the apps): who may read a key (#760), where the
        // server may connect (#756), one-hour database credentials and their
        // audit log (#746), and re-sealing under a replaced key (D7). Every
        // branch is a path by which a key could leak or a check be skipped.
        "**/lib/secrets.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/egress.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/credential-audit.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/tenant/db-credentials.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/crypto/reseal.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // Sign-in and sessions (bundle S8). An uncovered branch in any of these is
        // a reset link that outlives its limits, a session that survives a role
        // change or a sign-out-everywhere, or a forged token nobody hears about.
        "**/lib/password-reset.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/revoked-sessions.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // Sessions, sign-in risk and context-aware access (app-business-core
        // issues 506, 519, 525, 741): every branch is a sign-in or access decision.
        "**/lib/session/policy.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/session/risk.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/session/return-path.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/session/lifetime.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/session/records.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/session/hooks.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/session/guard.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/account-security.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/security-log.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/session-token-log.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // Data exposure (bundle S10). lib/dto.ts decides which fields leave the
        // server; lib/csrf.ts whether a write came from the app's own page in
        // this session; lib/crypto/field-seal.ts seals a payload field. An
        // uncovered branch is a field that reaches the browser, a forged write
        // that passes, or a field that opens when it should not.
        "**/lib/dto.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/csrf.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/crypto/field-seal.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        // Breached passwords and oversized requests (Dispatch AR): a branch here is
        // a breached password let through, or a too-large request not refused.
        "**/lib/password-breach.ts": {
          lines: 100,
          statements: 100,
          branches: 100,
          functions: 100,
        },
        "**/lib/request-size.ts": {
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
      // `import "server-only"` marks every server module (issue 797). The
      // package throws outside Next.js's "react-server" condition, so unit tests
      // load its empty half — the same module Next.js uses for server code.
      // tests/unit/server-boundary.test.ts holds the marker itself.
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
});
