"use server";

import { signIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { registerUser, RegistrationError } from "@/lib/users";
import { startTrialForNewOwner } from "@/lib/billing/trial";

export type SignupState = { error?: string } | null;

export async function signupAction(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const rawName = String(formData.get("name") ?? "").trim();

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  let user;
  try {
    user = await registerUser(db, {
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

  // Step 6: give the new owner a trial subscription so the step-5 paywall does
  // not lock them out of their own app on day one. This is the UI signup path
  // (a server action) — the same trial is created on the /api/auth/signup route.
  // A trial failure must not block sign-in; log and continue (they'd land on
  // /reactivate and can subscribe).
  try {
    await startTrialForNewOwner(db, user.id);
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
