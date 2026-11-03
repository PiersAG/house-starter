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
import { guardRouteAction, ROUTE_LIMIT_MESSAGE } from "@/lib/abuse/route-limit";
import {
  ChangePasswordError,
  changePassword,
  signOutEverywhere,
} from "@/lib/account-security";
import { z } from "zod";
import { newPasswordField, parseForm, passwordField } from "@/lib/validation/input";
import { endSessionRecord, getSessionRecord } from "@/lib/session/records";
import { owns } from "@/lib/ownership";
import { accessMessage, checkSensitiveAccess } from "@/lib/session/guard";
import { logSecurityEvent } from "@/lib/security-log";
import { revalidatePath } from "next/cache";

const SECURITY_PAGE = "/account/security";

export type ChangePasswordState = { error?: string; loginPath?: string } | null;

// Checked on the server (issue 442): both present, neither over-long, the new one
// long enough.
const changePasswordForm = z.object({
  currentPassword: z.string().min(1, "Enter your current and your new password.").pipe(passwordField),
  newPassword: z.string().min(1, "Enter your current and your new password.").pipe(newPasswordField),
});

export async function signOutEverywhereAction(): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    await signOut({ redirectTo: "/login" });
    return;
  }
  // The route limit (app-business-core issue 787): a refusal leaves the sessions as they are.
  if (await guardRouteAction("account.write", { accountId: userId })) return;
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
  if (await guardRouteAction("account.write", { accountId: userId })) return { error: ROUTE_LIMIT_MESSAGE };

  // Context-aware access (issue 741): changing how the account signs in is a
  // sensitive action — an unrecognised device at an unusual hour, a suspect
  // connection or a risky session must sign in again first.
  const access = await checkSensitiveAccess(catalogDb, session, "account.change-password", SECURITY_PAGE);
  const refused = accessMessage(access);
  if (refused) return { error: refused, loginPath: access.loginPath };

  // The current-password check is a password guess, so it is limited like one:
  // per client AND per account (the reset bucket — same kind of request).
  for (const rate of [
    await guardAuthAttempt(AUTH_RATE_LIMITS.resetPassword),
    await checkAccountRateLimit(AUTH_RATE_LIMITS.resetPassword, userId),
  ]) {
    if (!rate.allowed) return { error: "Too many attempts. Please try again shortly." };
  }

  const form = parseForm(changePasswordForm, formData);
  if (!form.ok) return { error: form.error };
  const { currentPassword: current, newPassword: next } = form.data;

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

// Sign one other device out (issue 506: the device list; issue 519: a sign-in the
// user does not recognise). Only a session of this account can be ended.
export async function endDeviceAction(formData: FormData): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    await signOut({ redirectTo: "/login" });
    return;
  }
  if (await guardRouteAction("account.write", { accountId: userId })) return;
  const form = parseForm(z.object({ sessionId: z.string().min(8).max(64) }), formData);
  if (!form.ok) return;
  // Only a session of this account (lib/ownership.ts; endSessionRecord checks again).
  const record = await getSessionRecord(catalogDb, form.data.sessionId);
  if (!record || record.userId !== userId || !owns(session, { ownerId: record.userId })) return;
  if (await endSessionRecord(catalogDb, { userId, sessionId: record.id, reason: "ended_by_user" })) {
    logSecurityEvent("session_ended", { userId, reason: "ended_by_user" });
  }
  revalidatePath(SECURITY_PAGE);
}

// After two-step sign-in is switched on (issue 377), this session still carries
// the "not set up" mark; signing in again with the code replaces it.
export async function finishTwoStepAction(): Promise<void> {
  const session = await auth();
  if (session?.user?.id && (await guardRouteAction("account.write", { accountId: session.user.id }))) return;
  await signOut({ redirectTo: "/login?twoStep=on" });
}
