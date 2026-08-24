"use server";

import { signIn } from "@/lib/auth";
import { catalogDb } from "@/lib/catalog";
import { registerUser, RegistrationError } from "@/lib/users";
import { startTrialForNewOwner } from "@/lib/billing/trial";
import { ensureTenantForUser } from "@/lib/tenant/provisioner";
import { AUTH_RATE_LIMITS, guardAuthAttempt } from "@/lib/auth-rate-limit";

export type SignupState = { error?: string } | null;

export async function signupAction(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  // Same bucket the JSON twin (POST /api/auth/signup) counts into, so the two
  // surfaces share one budget instead of handing an attacker two.
  const rate = await guardAuthAttempt(AUTH_RATE_LIMITS.signup);
  if (!rate.allowed) {
    return { error: "Too many signup attempts. Please try again shortly." };
  }

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const rawName = String(formData.get("name") ?? "").trim();

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  let user;
  try {
    user = await registerUser(catalogDb, {
      email,
      password,
      name: rawName.length > 0 ? rawName : null,
    });
  } catch (error) {
    if (error instanceof RegistrationError) {
      return { error: error.message };
    }
    return { error: "Could not create your account. Please try again." };
  }

  // ADR-023: the account exists in the catalog; now give it its OWN database.
  // This is the moment a tenant comes into being — a per-tenant app that skipped
  // it would hand the new customer a session pointing at nothing. It is fatal on
  // purpose: an account without a database cannot be signed in to, so reporting
  // "created" and then failing on the first page would be the worse outcome.
  // SECOND, MUCH TIGHTER BUCKET — and it guards a different resource. Above is
  // a request limit; this is the ceiling on how many DATABASES one client can
  // cause to exist, which is billed, quota'd and slow to reclaim. Checked here
  // rather than at entry so a rejected signup (bad email, taken address) does
  // not spend the provisioning budget.
  const provisionRate = await guardAuthAttempt(AUTH_RATE_LIMITS.signupProvision);
  if (!provisionRate.allowed) {
    // The account exists; only its workspace is deferred. lib/auth.ts::authorize
    // provisions on first sign-in, so this is recoverable exactly as the message
    // says — no orphaned account, no support ticket.
    return {
      error:
        "Your account was created, but too many workspaces have been set up " +
        "from this network recently. Try signing in shortly and we'll finish " +
        "setting it up.",
    };
  }

  try {
    await ensureTenantForUser(user.id, { label: user.email });
  } catch (error) {
    console.error("signup: failed to provision the tenant database", error);
    return {
      error:
        "Your account was created but its workspace could not be set up. " +
        "Try signing in — we'll finish setting it up then.",
    };
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
