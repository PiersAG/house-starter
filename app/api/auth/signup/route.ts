// POST /api/auth/signup — create a new account.
//
// Sits alongside the NextAuth catch-all (app/api/auth/[...nextauth]) — an
// explicit route segment takes precedence over the catch-all in the App Router.
// Verified via the Playwright E2E suite (excluded from unit coverage).

import { NextResponse } from "next/server";
import { z } from "zod";
import { catalogDb } from "@/lib/catalog";
import { registerUser, RegistrationError } from "@/lib/users";
import { startTrialForNewOwner } from "@/lib/billing/trial";
import { ensureTenantForUser } from "@/lib/tenant/provisioner";
import { AUTH_RATE_LIMITS, checkAuthRateLimit } from "@/lib/auth-rate-limit";

export const runtime = "nodejs";

const signupSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters long."),
  name: z.string().trim().min(1).max(120).optional(),
});

// Auth endpoints are rate-limited (quality baseline items 4 and 11). The limits
// and the buckets live in lib/auth-rate-limit.ts — ONE definition shared with
// the signup SERVER ACTION, which posts to the same bucket. Two definitions
// would drift, and two buckets would hand an attacker two budgets.

export async function POST(request: Request): Promise<Response> {
  const rate = await checkAuthRateLimit(
    AUTH_RATE_LIMITS.signup,
    request.headers,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many signup attempts. Please try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = signupSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid signup details." },
      { status: 400 },
    );
  }

  // The tighter provisioning ceiling — see lib/auth-rate-limit.ts. Checked
  // after validation so a malformed request cannot spend the budget, and before
  // registration because this route (unlike the server action) reports failure
  // as a status code the caller can retry cleanly.
  const provisionRate = await checkAuthRateLimit(
    AUTH_RATE_LIMITS.signupProvision,
    request.headers,
  );
  if (!provisionRate.allowed) {
    return NextResponse.json(
      {
        error:
          "Too many new workspaces have been created from this network. " +
          "Please try again later.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(provisionRate.retryAfterSeconds) },
      },
    );
  }

  try {
    const user = await registerUser(catalogDb, parsed.data);
    // ADR-023: give the new account its OWN database and register it in the
    // catalog, so the very next sign-in can be routed. Same call the UI signup
    // path makes; idempotent, so a retry after a partial failure converges.
    await ensureTenantForUser(user.id, { label: user.email });
    // Step 6: give the new owner a trial subscription so the step-5 paywall does
    // not lock them out of their own app on day one (length from the settings
    // registry — billing.trial_period_days).
    await startTrialForNewOwner(catalogDb, user.id);
    return NextResponse.json(
      { id: user.id, email: user.email, name: user.name },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof RegistrationError) {
      const status = error.code === "email_taken" ? 409 : 422;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }
}
