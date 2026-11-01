"use server";

// Account security actions (app-business-core issue 506). The work and its
// tests are in lib/account-security.ts; this file adds the session, the attempt
// limit and the sign-out that follows. Both actions end every session of the
// account, this browser's included, so both finish by signing out here and
// sending the user to sign in again.

import { auth, signOut } from "@/lib/auth";
import { catalogDb } from "@/lib/catalog";
import {
  AUTH_RATE_LIMITS,
  checkAccountRateLimit,
  guardAuthAttempt,
} from "@/lib/auth-rate-limit";
import {
  ChangePasswordError,
  changePassword,
  signOutEverywhere,
} from "@/lib/account-security";

export type ChangePasswordState = { error?: string } | null;

export async function signOutEverywhereAction(): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    await signOut({ redirectTo: "/login" });
    return;
  }
  await signOutEverywhere(catalogDb, userId);
  await signOut({ redirectTo: "/login?signedOut=all" });
}

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: "Your session has ended. Sign in again." };

  // The current-password check is a password guess, so it is limited like one:
  // per client AND per account (the reset bucket — same kind of request).
  for (const rate of [
    await guardAuthAttempt(AUTH_RATE_LIMITS.resetPassword),
    await checkAccountRateLimit(AUTH_RATE_LIMITS.resetPassword, userId),
  ]) {
    if (!rate.allowed) return { error: "Too many attempts. Please try again shortly." };
  }

  const current = String(formData.get("currentPassword") ?? "");
  const next = String(formData.get("newPassword") ?? "");
  if (!current || !next) return { error: "Enter your current and your new password." };

  try {
    await changePassword(catalogDb, userId, current, next);
  } catch (error) {
    if (error instanceof ChangePasswordError) return { error: error.message };
    return { error: "Could not change your password. Please try again." };
  }
  // signOut redirects (throws NEXT_REDIRECT), so it stays outside the try.
  await signOut({ redirectTo: "/login?password=changed" });
  return null;
}
