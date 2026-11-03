"use server";

import { signIn } from "@/lib/auth";
import { catalogDb } from "@/lib/catalog";
import { registerUser, RegistrationError } from "@/lib/users";
import { startTrialForNewOwner } from "@/lib/billing/trial";
import {
  provisionNewAccount,
  SIGNUP_PROVISION_FAILED_MESSAGE,
} from "@/lib/tenant/signup-provisioning";
import { AUTH_RATE_LIMITS, guardAuthAttempt } from "@/lib/auth-rate-limit";
import { guardRouteAction, ROUTE_LIMIT_MESSAGE } from "@/lib/abuse/route-limit";
import { z } from "zod";
import {
  emailField,
  newPasswordField,
  optionalNameField,
  parseForm,
} from "@/lib/validation/input";

export type SignupState = { error?: string } | null;

// The form's fields, checked on the server whatever the browser did (issue 442):
// email format, password length, and a name with no markup or links (issue 758).
// Any other field — role, plan, isAdmin — is stripped and never reaches
// registerUser.
const signupForm = z.object({
  email: emailField,
  password: newPasswordField,
  name: optionalNameField,
});

export async function signupAction(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  // The route limit and escalation (app-business-core issues 787 and 748).
  if (await guardRouteAction("auth.signup")) return { error: ROUTE_LIMIT_MESSAGE };

  // Same bucket the JSON twin (POST /api/auth/signup) counts into, so the two
  // surfaces share one budget instead of handing an attacker two.
  const rate = await guardAuthAttempt(AUTH_RATE_LIMITS.signup);
  if (!rate.allowed) {
    return { error: "Too many signup attempts. Please try again shortly." };
  }

  const form = parseForm(signupForm, formData);
  if (!form.ok) return { error: form.error };
  const { email, password, name } = form.data;

  // SECOND, MUCH TIGHTER BUCKET — and it guards a different resource. Above is
  // a request limit; this is the ceiling on how many DATABASES one client can
  // cause to exist, which is billed, quota'd and slow to reclaim. Checked after
  // the form is valid, so a malformed request does not spend it, and BEFORE the
  // account is made (app-business-core issue 358: never a half-created account),
  // as the JSON twin (POST /api/auth/signup) already does.
  const provisionRate = await guardAuthAttempt(AUTH_RATE_LIMITS.signupProvision);
  if (!provisionRate.allowed) {
    return {
      error:
        "Too many new accounts have been set up from this network recently. " +
        "Please try again later.",
    };
  }

  let user;
  try {
    user = await registerUser(catalogDb, { email, password, name });
  } catch (error) {
    if (error instanceof RegistrationError) {
      return { error: error.message };
    }
    // LOG IT. A RegistrationError is an expected, self-explaining refusal
    // (address taken, password too weak) and its message reaches the user. This
    // branch is everything else — the UNEXPECTED failures — and it used to
    // return the generic message while recording nothing at all. That is how
    // BLD.12 stayed invisible: the catalog had no `users` table in per_tenant
    // mode, so registerUser threw `SQLITE_ERROR: no such table: users` on every
    // attempt, and all anyone could see was "Could not create your account".
    // The two sibling catches below already log; this one is the outlier.
    // User-facing message deliberately unchanged — it must not leak internals.
    console.error("signup: failed to register the account", error);
    return { error: "Could not create your account. Please try again." };
  }

  // ADR-023: the account exists in the catalog; now give it its OWN database —
  // all or nothing (app-business-core issue 358). provisionNewAccount retries
  // Turso's passing errors, checks the new database opens by the catalog's
  // route, and on any failure rolls the sign-up back, so no account is left
  // without a database and the address can sign up again at once.
  // provisionNewAccount never throws by design; the try is the second line of
  // defence, so the form still shows the fixed message, never a 500.
  let provisioned;
  try {
    provisioned = await provisionNewAccount(user.id, user.email);
  } catch (error) {
    console.error("signup: provisioning threw past its own rollback", error);
    return { error: SIGNUP_PROVISION_FAILED_MESSAGE };
  }
  if (!provisioned.ok) {
    return { error: SIGNUP_PROVISION_FAILED_MESSAGE };
  }

  // Step 6: give the new owner a trial subscription so the step-5 paywall does
  // not lock them out of their own app on day one. This is the UI signup path
  // (a server action) — the same trial is created on the /api/auth/signup route.
  // A trial failure must not block sign-in; log and continue (they'd land on
  // /reactivate and can subscribe).
  try {
    await startTrialForNewOwner(catalogDb, user.id);
  } catch (error) {
    console.error("signup: failed to start trial subscription", error);
  }

  // Account created — sign the user straight in and send them to the dashboard.
  await signIn("credentials", {
    email,
    password,
    redirectTo: "/dashboard",
  });
  return null;
}
