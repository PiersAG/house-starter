"use server";

// "Your data" actions (app-business-core issues 722, 351, 288; Matt Murphy
// step 288: "add a delete my data button to the app"; step 156: "generate a data report
// of everything you hold on that user"). The work and its tests are in
// lib/privacy/; this file adds the session, the attempt limit, the password
// check and the sign-out that follows a deletion.
//
// Part of the account kernel (`auth`): when it is off, both actions refuse, as
// the page itself is absent (404).

import { auth, signOut } from "@/lib/auth";
import { catalogDb } from "@/lib/catalog";
import { isKernelEnabled } from "@/config/kernel";
import { AUTH_RATE_LIMITS, checkAccountRateLimit, guardAuthAttempt } from "@/lib/auth-rate-limit";
import { verifyPassword } from "@/lib/password";
import { getUserById } from "@/lib/users";
import { getTenantDb } from "@/lib/tenant-context";
import { guardRouteAction, ROUTE_LIMIT_MESSAGE } from "@/lib/abuse/route-limit";
import { buildDataReport } from "@/lib/privacy/data-report";
import { DeletionError, requestAccountDeletion } from "@/lib/privacy/deletion";
import { sendDeletionRequested } from "@/lib/privacy/runtime";
import { z } from "zod";
import { parseForm, passwordField } from "@/lib/validation/input";
import { accessMessage, checkSensitiveAccess } from "@/lib/session/guard";

export type DownloadState = { error?: string; report?: string; loginPath?: string } | null;
export type DeleteState = { error?: string; loginPath?: string } | null;

const PRIVACY_PAGE = "/account/privacy";

const NOT_AVAILABLE = "This is not available in this app.";

async function limited(userId: string): Promise<boolean> {
  for (const rate of [
    await guardAuthAttempt(AUTH_RATE_LIMITS.resetPassword),
    await checkAccountRateLimit(AUTH_RATE_LIMITS.resetPassword, userId),
  ]) {
    if (!rate.allowed) return true;
  }
  return false;
}

/** Everything the app holds on the signed-in account, as JSON text to download. */
export async function downloadMyDataAction(): Promise<DownloadState> {
  if (!isKernelEnabled("auth")) return { error: NOT_AVAILABLE };
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: "Your session has ended. Sign in again." };
  if (await guardRouteAction("account.write", { accountId: userId })) return { error: ROUTE_LIMIT_MESSAGE };
  if (await limited(userId)) return { error: "Too many attempts. Please try again shortly." };
  // Context-aware access (issue 741): a copy of everything held on the person.
  const access = await checkSensitiveAccess(catalogDb, session, "privacy.data-report", PRIVACY_PAGE);
  const refused = accessMessage(access);
  if (refused) return { error: refused, loginPath: access.loginPath };
  let tenant = null;
  try {
    tenant = await getTenantDb();
  } catch {
    tenant = null;
  }
  const report = await buildDataReport(catalogDb, userId, { tenant });
  if (!report) return { error: "This account no longer exists." };
  return { report: JSON.stringify(report, null, 2) };
}

// Checked on the server (issue 442): the password, and the word typed to confirm.
const deleteForm = z.object({
  password: z.string().min(1, "Enter your password to confirm.").pipe(passwordField),
  confirm: z.string().trim().refine((v) => v.toUpperCase() === "DELETE", {
    message: "Type DELETE to confirm.",
  }),
});

/** Close the account now; its data is erased 30 days later. */
export async function deleteMyAccountAction(_prev: DeleteState, formData: FormData): Promise<DeleteState> {
  if (!isKernelEnabled("auth")) return { error: NOT_AVAILABLE };
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: "Your session has ended. Sign in again." };
  if (await guardRouteAction("account.write", { accountId: userId })) return { error: ROUTE_LIMIT_MESSAGE };
  // The password check is a password guess, so it is limited like one.
  if (await limited(userId)) return { error: "Too many attempts. Please try again shortly." };
  // Context-aware access (issue 741): closing the account.
  const access = await checkSensitiveAccess(catalogDb, session, "privacy.delete-account", PRIVACY_PAGE);
  const refused = accessMessage(access);
  if (refused) return { error: refused, loginPath: access.loginPath };

  const form = parseForm(deleteForm, formData);
  if (!form.ok) return { error: form.error };
  const user = await getUserById(catalogDb, userId);
  if (!user || !(await verifyPassword(form.data.password, user.passwordHash))) {
    return { error: "That password is not right." };
  }
  try {
    const { deletionDueAt, email } = await requestAccountDeletion(catalogDb, userId);
    await sendDeletionRequested(email, deletionDueAt);
  } catch (error) {
    if (error instanceof DeletionError) return { error: error.message };
    return { error: "Could not delete your account. Please try again." };
  }
  // signOut redirects (throws NEXT_REDIRECT), so it stays outside the try.
  await signOut({ redirectTo: "/account-closed" });
  return null;
}
