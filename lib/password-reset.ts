// Password-reset token lifecycle + the forgot/reset orchestration.
//
// DI pattern of lib/users.ts: every function takes the Drizzle database as an
// explicit argument so the whole flow is unit-tested against an in-memory
// database. Security properties, enforced here and asserted by the tests:
//   - the raw token is returned ONCE (to email) and NEVER stored — only a
//     SHA-256 hash is persisted, so a DB read yields no usable link;
//   - tokens are single-use (usedAt claimed atomically on consume);
//   - tokens expire after 15 minutes (expiresAt checked on verify/consume);
//   - at most RESET_REQUESTS_PER_EMAIL links per account per hour, on top of
//     the per-IP throttle on the route (Matt Murphy #27, #515);
//   - a completed reset cancels every other open link for that account;
//   - requests and completions are logged (lib/security-log.ts) — never the
//     token, the link or the email address;
//   - forgot-password never reveals whether an email is registered (no
//     account enumeration) — a limited request looks exactly like a sent one.

import { and, count, eq, gt, isNull } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { passwordResetTokens, users } from "@/lib/schema";
import { getUserByEmail, type AppDatabase } from "@/lib/users";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
import { sendEmail } from "@/lib/email/send";
import { resetPasswordTemplate } from "@/lib/email/templates/reset-password";
import { logSecurityEvent } from "@/lib/security-log";

/** Raw token entropy in bytes. */
const TOKEN_BYTES = 32;

/** How long a reset token is valid (Matt Murphy #27: 15 minutes). */
export const RESET_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Most reset links one account can be sent per RESET_REQUEST_WINDOW_SECONDS.
 * Counted per ACCOUNT in the database, so it holds across server instances and
 * cold starts and is not reset by rotating IP addresses; the per-IP throttle on
 * the forgot-password route (AUTH_RATE_LIMITS.forgotPassword) still applies.
 */
export const RESET_REQUESTS_PER_EMAIL = 3;
export const RESET_REQUEST_WINDOW_SECONDS = 60 * 60;

/** SHA-256 hash of a raw token — what we store and look up by. */
export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface CreatedResetToken {
  /** The RAW token — email it, then discard. Never persisted. */
  token: string;
  expiresAt: Date;
}

/** Issue a new reset token for a user. Stores only the hash. */
export async function createPasswordResetToken(
  db: AppDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<CreatedResetToken> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_SECONDS * 1000);
  await db
    .insert(passwordResetTokens)
    .values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: hashResetToken(token),
      expiresAt,
      // Written from `now` (not the column default) so the per-account request
      // count below reads the same clock the expiry does.
      createdAt: now,
    })
    .run();
  return { token, expiresAt };
}

/**
 * Verify a raw token WITHOUT consuming it. Returns the token row's id and
 * userId when the token exists, is unused, and is unexpired; otherwise null.
 */
export async function verifyPasswordResetToken(
  db: AppDatabase,
  rawToken: string,
  now: Date = new Date(),
): Promise<{ id: string; userId: string } | null> {
  const rows = await db
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, hashResetToken(rawToken)))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return { id: row.id, userId: row.userId };
}

/**
 * Atomically claim (single-use) a valid token and return its userId, or null
 * if it is unknown, already used, or expired. The UPDATE guards on usedAt IS
 * NULL so two concurrent consumers cannot both succeed.
 */
export async function consumePasswordResetToken(
  db: AppDatabase,
  rawToken: string,
  now: Date = new Date(),
): Promise<string | null> {
  const valid = await verifyPasswordResetToken(db, rawToken, now);
  if (!valid) return null;
  const result = await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(and(eq(passwordResetTokens.id, valid.id), isNull(passwordResetTokens.usedAt)))
    .run();
  return result.rowsAffected === 1 ? valid.userId : null;
}

export type PasswordResetErrorCode = "invalid_token" | "weak_password";

export class PasswordResetError extends Error {
  constructor(
    public readonly code: PasswordResetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PasswordResetError";
  }
}

/**
 * How many reset links were issued for this account in the last
 * RESET_REQUEST_WINDOW_SECONDS — used or not, so spending a link does not buy
 * another one.
 */
export async function countRecentResetRequests(
  db: AppDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - RESET_REQUEST_WINDOW_SECONDS * 1000);
  const rows = await db
    .select({ n: count() })
    .from(passwordResetTokens)
    .where(
      and(eq(passwordResetTokens.userId, userId), gt(passwordResetTokens.createdAt, since)),
    )
    .all();
  // An aggregate always returns exactly one row.
  return rows[0].n;
}

/**
 * Cancel every open (unused) reset link for an account by marking it used.
 * Returns how many were cancelled.
 */
export async function cancelOpenResetTokens(
  db: AppDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const result = await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)))
    .run();
  return result.rowsAffected;
}

/**
 * Complete a reset: validate the new password, atomically consume the token,
 * and set the user's new password hash. The same write sets the per-user
 * session cutoff (`sessionsValidFrom = now`), so every session that signed in
 * before the reset is rejected at its next renewal. Every other open reset link
 * for the account is then cancelled, so an older or extra email cannot be used
 * as a standing key. Throws PasswordResetError on a weak password (before any
 * DB write) or an invalid/expired/used token.
 */
export async function resetPassword(
  db: AppDatabase,
  rawToken: string,
  newPassword: string,
  now: Date = new Date(),
): Promise<{ userId: string }> {
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) {
    throw new PasswordResetError("weak_password", strengthError);
  }
  const userId = await consumePasswordResetToken(db, rawToken, now);
  if (!userId) {
    throw new PasswordResetError(
      "invalid_token",
      "This reset link is invalid, has expired, or has already been used.",
    );
  }
  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, sessionsValidFrom: now })
    .where(eq(users.id, userId))
    .run();
  const cancelled = await cancelOpenResetTokens(db, userId, now);
  logSecurityEvent("password_reset_completed", { userId, otherLinksCancelled: cancelled }, now);
  return { userId };
}

/**
 * Handle a forgot-password request: if the email belongs to a user, issue a
 * token and email the reset link. Returns silently either way — the caller
 * responds identically whether or not the email is registered, so an attacker
 * cannot enumerate accounts.
 */
export async function requestPasswordReset(
  db: AppDatabase,
  email: string,
  options: { baseUrl: string; appName?: string },
  now: Date = new Date(),
): Promise<void> {
  const user = await getUserByEmail(db, email);
  if (!user) {
    logSecurityEvent("password_reset_requested", { knownAccount: false }, now);
    return;
  }
  const recent = await countRecentResetRequests(db, user.id, now);
  if (recent >= RESET_REQUESTS_PER_EMAIL) {
    // Same silent return as an unknown email: the caller's response does not
    // change, so the limit reveals nothing about the account.
    logSecurityEvent(
      "password_reset_request_limited",
      { userId: user.id, requestsThisHour: recent },
      now,
    );
    return;
  }
  const { token } = await createPasswordResetToken(db, user.id, now);
  logSecurityEvent("password_reset_requested", { knownAccount: true, userId: user.id }, now);
  const resetUrl = `${options.baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail(user.email, resetPasswordTemplate, {
    resetUrl,
    appName: options.appName,
  });
}
