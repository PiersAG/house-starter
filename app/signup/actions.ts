"use server";

import { signIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { registerUser, RegistrationError } from "@/lib/users";

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

  try {
    await registerUser(db, {
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

  // Account created — sign the user straight in and send them to the dashboard.
  await signIn("credentials", {
    email,
    password,
    redirectTo: "/dashboard",
  });
  return null;
}
