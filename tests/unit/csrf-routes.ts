// Write endpoints the request-token check (lib/csrf.ts, app-business-core issue
// 353) does not cover, with the reason — read by tests/unit/csrf.test.ts (the
// source holds the check) and tests/e2e/csrf.spec.ts (the running app refuses
// another website on every other write endpoint).

/** Write endpoints that need neither check, with the reason. */
export const EXEMPT: Record<string, string> = {
  "app/api/auth/[...nextauth]/route.ts": "Auth.js checks its own CSRF token on sign-in and sign-out (the csrfToken form field).",
  "app/api/billing/webhook/route.ts": "Stripe's servers call it, not a browser; every event's signature is checked against the webhook secret.",
  "app/api/csp-report/route.ts": "Browsers send violation reports without cookies; it changes nothing and always answers 204.",
};

/**
 * Write endpoints not yet checked, with who adds it. The test fails when a
 * listed route already has the check, so each line goes when its change lands.
 */
export const PENDING: Record<string, string> = {
  // Money path: frozen for Dispatch AB while Dispatch AA's payments change lands.
  "app/api/billing/checkout/route.ts": "next payments dispatch",
  "app/api/billing/portal/route.ts": "next payments dispatch",
  // Sign-in kernel: the safety gate keeps these from Claude Code; Dispatch AB's
  // CEO script applies verifySameOrigin and removes these two lines.
  "app/api/auth/signup/route.ts": "kernel edit in the CEO script",
  "app/api/auth/forgot-password/route.ts": "kernel edit in the CEO script",
};
