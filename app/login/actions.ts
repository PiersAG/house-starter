"use server";

import { signIn } from "@/lib/auth";
import { AuthError } from "next-auth";
import { isAuthRateLimitError } from "@/lib/auth-rate-limit";

export async function loginAction(
  _prev: { error?: string } | null,
  formData: FormData,
): Promise<{ error: string } | null> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      rememberMe: formData.get("rememberMe"),
      redirectTo: "/dashboard",
    });
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      // The limit itself is enforced in lib/auth.ts::authorize (the path the
      // public NextAuth endpoint shares). All this does is stop a throttled
      // person being told their password is wrong.
      if (isAuthRateLimitError(error)) {
        return { error: "Too many sign-in attempts. Please try again shortly." };
      }
      return { error: "Invalid email or password." };
    }
    // Re-throw redirect — Next.js needs it to bubble up.
    throw error;
  }
}
