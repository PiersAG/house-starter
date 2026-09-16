"use server";

import { signIn } from "@/lib/auth";
import { AuthError } from "next-auth";
import { isAuthRateLimitError } from "@/lib/auth-rate-limit";
import { mfaSignInReason, submittedCode } from "@/lib/mfa/sign-in";

type LoginState = { error: string; mfaRequired?: boolean } | null;

// The second factor (SEC.15) is checked in lib/auth.ts::authorize, on the path
// the public NextAuth endpoint shares. It stops a sign-in by THROWING a reason
// (lib/mfa/sign-in.ts); all this does is turn that reason into words and keep
// the code field on screen.
const MFA_MESSAGES = {
  mfa_code_required:
    "Enter the 6-digit code from your authenticator app, or one of your recovery codes.",
  mfa_code_invalid:
    "That code didn't work. Enter the current code from your app, or a recovery code.",
  mfa_totp_locked: "Too many wrong codes. Sign in with one of your recovery codes.",
} as const;

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      rememberMe: formData.get("rememberMe"),
      code: formData.get("code") ?? "",
      redirectTo: "/dashboard",
    });
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      // The limit itself is enforced in lib/auth.ts::authorize (the path the
      // public NextAuth endpoint shares). All this does is stop a throttled
      // person being told their password is wrong — and keep the code field
      // showing if they were already at the code step.
      if (isAuthRateLimitError(error)) {
        return {
          error: "Too many sign-in attempts. Please try again shortly.",
          mfaRequired: submittedCode(formData.get("code")) !== "",
        };
      }
      const reason = mfaSignInReason(error);
      if (reason) return { error: MFA_MESSAGES[reason], mfaRequired: true };
      return { error: "Invalid email or password." };
    }
    // Re-throw redirect — Next.js needs it to bubble up.
    throw error;
  }
}
