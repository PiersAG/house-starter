"use server";

import { redirect } from "next/navigation";
import { catalogDb } from "@/lib/catalog";
import { PasswordResetError, resetPassword } from "@/lib/password-reset";
import { AUTH_RATE_LIMITS, guardAuthAttempt } from "@/lib/auth-rate-limit";

export type ResetPasswordState = { error?: string } | null;

export async function resetPasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  // Throttled BEFORE the token is looked at: an unthrottled reset endpoint is
  // an offline-free oracle for guessing reset tokens.
  const rate = await guardAuthAttempt(AUTH_RATE_LIMITS.resetPassword);
  if (!rate.allowed) {
    return { error: "Too many attempts. Please try again shortly." };
  }

  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!token) {
    return { error: "This reset link is missing its token. Request a new one." };
  }
  if (!password) {
    return { error: "Enter a new password." };
  }

  try {
    await resetPassword(catalogDb, token, password);
  } catch (error) {
    if (error instanceof PasswordResetError) {
      return { error: error.message };
    }
    return { error: "Could not reset your password. Please try again." };
  }

  // Success — send them to sign in with the new password. redirect() throws
  // NEXT_REDIRECT, so it MUST live outside the try/catch above.
  redirect("/login?reset=success");
}
