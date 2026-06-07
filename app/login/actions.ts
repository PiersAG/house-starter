"use server";

import { signIn } from "@/lib/auth";
import { AuthError } from "next-auth";

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
      return { error: "Invalid email or password." };
    }
    // Re-throw redirect — Next.js needs it to bubble up.
    throw error;
  }
}
