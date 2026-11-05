// Account security actions a signed-in user takes on their own account
// (PiersAG/app-business-core#506, Matt Murphy #133 and #52):
//
//   - "Sign out of all devices" — for a user who thinks a session was copied.
//   - Change password while signed in (current password required).
//
// Both end EVERY session of the account, this one included, through the one
// mechanism the template already has: the per-user cutoff
// `users.sessions_valid_from` (lib/revoked-sessions.ts). A session that signed
// in before the cutoff is refused at its next renewal (at most
// RENEW_AFTER_SECONDS later); the action that called these signs the current
// browser out at once. Making OTHER devices stop instantly, rather than within
// one renewal window, is the "strict" session policy (config/sessions.ts),
// which checks on every server request; turning it on is CEO decision #559
// (it changes the 2026-07-15 session ruling).
//
// DI pattern of lib/users.ts: the database is an explicit argument so the flow
// is unit-tested against an in-memory database.

import "server-only";

import { eq } from "drizzle-orm";
import { users } from "@/lib/schema";
import { getUserById, type AppDatabase } from "@/lib/users";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/password";
import { breachedPasswordError } from "@/lib/password-breach";
import { cancelOpenResetTokens } from "@/lib/password-reset";
import { logSecurityEvent } from "@/lib/security-log";
import { endAllSessionRecords } from "@/lib/session/records";

/**
 * End every session of this account at its next renewal. Also cancels any open
 * password-reset link, since a user who fears a stolen session may also fear a
 * stolen inbox link.
 */
export async function signOutEverywhere(
  db: AppDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.update(users).set({ sessionsValidFrom: now }).where(eq(users.id, userId)).run();
  await endAllSessionRecords(db, userId, "ended_by_user", now);
  const cancelled = await cancelOpenResetTokens(db, userId, now);
  logSecurityEvent("signed_out_everywhere", { userId, resetLinksCancelled: cancelled }, now);
}

export type ChangePasswordErrorCode = "wrong_password" | "weak_password" | "same_password";

export class ChangePasswordError extends Error {
  constructor(
    public readonly code: ChangePasswordErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChangePasswordError";
  }
}

/**
 * Change the password of a signed-in user. The current password is checked
 * first, so a borrowed unlocked browser cannot take the account over. On
 * success every session of the account ends (same cutoff as a reset) and every
 * open reset link is cancelled. Throws ChangePasswordError; nothing is written
 * unless every check passes.
 */
export async function changePassword(
  db: AppDatabase,
  userId: string,
  currentPassword: string,
  newPassword: string,
  now: Date = new Date(),
): Promise<void> {
  const user = await getUserById(db, userId);
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new ChangePasswordError("wrong_password", "Your current password is not correct.");
  }
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) throw new ChangePasswordError("weak_password", strengthError);
  if (newPassword === currentPassword) {
    throw new ChangePasswordError(
      "same_password",
      "Choose a new password that is different from your current one.",
    );
  }
  const breached = await breachedPasswordError(newPassword, "change");
  if (breached) throw new ChangePasswordError("weak_password", breached);
  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, sessionsValidFrom: now })
    .where(eq(users.id, userId))
    .run();
  await endAllSessionRecords(db, userId, "ended_by_user", now);
  const cancelled = await cancelOpenResetTokens(db, userId, now);
  logSecurityEvent("password_changed", { userId, resetLinksCancelled: cancelled }, now);
}
