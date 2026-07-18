"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { PasswordResetError, resetPassword } from "@/lib/password-reset";

export type ResetPasswordState = { error?: string } | null;

export async function resetPasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!token) {
    return { error: "This reset link is missing its token. Request a new one." };
  }
  if (!password) {
    return { error: "Enter a new password." };
  }

  try {
    await resetPassword(db, token, password);
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
