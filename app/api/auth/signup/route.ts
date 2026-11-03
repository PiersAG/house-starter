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
import {
  provisionNewAccount,
  SIGNUP_FAILED_RETRY_SECONDS,
  SIGNUP_PROVISION_FAILED_MESSAGE,
} from "@/lib/tenant/signup-provisioning";
import { AUTH_RATE_LIMITS, checkAuthRateLimit } from "@/lib/auth-rate-limit";
import { verifySameOrigin } from "@/lib/csrf";

import { withRouteLimit } from "@/lib/abuse/route-limit";
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

async function postWithoutLimit(request: Request): Promise<Response> {
  // Issue 353: another website's page cannot create accounts through a visitor.
  const foreign = verifySameOrigin(request);
  if (foreign) return foreign;

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
    // ADR-023: give the new account its OWN database — all or nothing
    // (app-business-core issue 358). Same call the UI signup path makes: it
    // records the new tenant id first, retries Turso's passing errors,
    // checks the database opens by the catalog's route, and on failure rolls
    // the sign-up back. Every failure gets the one fixed message (CEO ruling
    // 2026-11-03: never told to wait), and a retry with the same email works
    // at once (lib/users.ts registerUser removes an unfinished sign-up).
    const provisioned = await provisionNewAccount(user.id, user.email);
    if (!provisioned.ok) {
      return NextResponse.json(
        { error: SIGNUP_PROVISION_FAILED_MESSAGE },
        { status: 503, headers: { "Retry-After": String(SIGNUP_FAILED_RETRY_SECONDS) } },
      );
    }
    // Step 6: give the new owner a trial subscription so the step-5 paywall does
    // not lock them out of their own app on day one (length from the settings
    // registry — billing.trial_period_days). As on the form: a trial failure
    // must not undo a finished account; they land on /reactivate and subscribe.
    try {
      await startTrialForNewOwner(catalogDb, user.id);
    } catch (trialError) {
      console.error("signup: failed to start trial subscription", trialError);
    }
    return NextResponse.json(
      { id: user.id, email: user.email, name: user.name },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof RegistrationError) {
      const status = error.code === "email_taken" ? 409 : 422;
      return NextResponse.json({ error: error.message }, { status });
    }
    // Anything else is unexpected — including a retry that lost to another
    // retry at the same moment (lib/users.ts SignupRetryError): logged here,
    // never shown (issue 358: never a crash), not a 500 and not the error's
    // own text. The caller gets the same fixed answer as a failed set-up.
    console.error("signup: the account could not be created", error);
    return NextResponse.json(
      { error: SIGNUP_PROVISION_FAILED_MESSAGE },
      { status: 503, headers: { "Retry-After": String(SIGNUP_FAILED_RETRY_SECONDS) } },
    );
  }
}

// The route limit and escalation (app-business-core issues 787 and 748).
export const POST = withRouteLimit("auth.signup", postWithoutLimit);
