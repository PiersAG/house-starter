"use server";

import { signIn } from "@/lib/auth";
import { AuthError } from "next-auth";
import { isAuthRateLimitError } from "@/lib/auth-rate-limit";
import { guardRouteAction, recordBehaviour, ROUTE_LIMIT_MESSAGE } from "@/lib/abuse/route-limit";
import { headers } from "next/headers";
import { mfaSignInReason, submittedCode } from "@/lib/mfa/sign-in";
import { z } from "zod";
import { emailField, parseForm, passwordField, textField } from "@/lib/validation/input";
import { safeReturnPath } from "@/lib/session/return-path";
import { ensureDeviceCookie } from "@/lib/session/context";

type LoginState = { error: string; mfaRequired?: boolean } | null;

// Checked here before anything is handed to sign-in (issue 442), and again by the
// credentials schema in the sign-in kernel's authorize step, which the public
// NextAuth endpoint shares. A malformed value gets the same answer as a wrong
// password.
// Only whether a second-factor code was typed, for keeping the code field on
// screen after a refusal.
const codeOnly = z.object({ code: z.string().max(64).optional() });
function codeTyped(formData: FormData): boolean {
  const form = parseForm(codeOnly, formData);
  return form.ok && submittedCode(form.data.code) !== "";
}

const loginForm = z.object({
  email: emailField,
  password: passwordField,
  rememberMe: z.literal("on").optional(),
  code: textField({ max: 32 }).optional(),
  // The page to return to after signing in (issue 525) — any value is accepted
  // here and reduced to a safe local path below; an off-site one is dropped.
  callbackUrl: z.string().max(1024).optional(),
});

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
  // The route limit and escalation (app-business-core issues 787 and 748) before
  // anything else; the per-attempt sign-in limit still runs inside authorize.
  if (await guardRouteAction("auth.signin")) {
    return { error: ROUTE_LIMIT_MESSAGE, mfaRequired: codeTyped(formData) };
  }
  const form = parseForm(loginForm, formData);
  if (!form.ok) {
    return {
      error: "Invalid email or password.",
      mfaRequired: codeTyped(formData),
    };
  }
  const { email, password, rememberMe, code, callbackUrl } = form.data;
  // This browser's device id, for the sign-in risk checks and the device list
  // (issues 519 and 506). A browser that never signed in here gets one now.
  await ensureDeviceCookie();
  try {
    await signIn("credentials", {
      email,
      password,
      rememberMe,
      code: code ?? "",
      // Back to the page the user was on (issue 525), never off this app (issue 514).
      redirectTo: safeReturnPath(callbackUrl),
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
          mfaRequired: codeTyped(formData),
        };
      }
      const reason = mfaSignInReason(error);
      if (reason) return { error: MFA_MESSAGES[reason], mfaRequired: true };
      // A refused sign-in scores against the client (behaviour, not just
      // volume): slow password guessing under every limit is still banned.
      await recordBehaviour(await headers(), "auth_refused");
      return { error: "Invalid email or password." };
    }
    // Re-throw redirect — Next.js needs it to bubble up.
    throw error;
  }
}
