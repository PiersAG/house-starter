// MFA enrollment and verification against the CATALOG (SEC.15, Slice 1).
//
// Everything an account's second factor needs is account-level data, so every
// read and write here goes to the catalog database passed in — and ONLY to it.
// No tenant database is opened on any MFA path, and nothing here reads or
// changes which tenant a session maps to. The second factor is settled during
// sign-in, before a tenant is resolved (lib/auth.ts::authorize).
//
// THE RULES THIS MODULE HOLDS
// ---------------------------
//   • Who MUST use MFA (Slice 1): an account holding a LIVE OWNER grant
//     (lib/billing/grants.ts). Anyone who has CHOSEN to enroll is also held to it
//     — an active factor is always checked. Everyone else signs in as before.
//   • Anti-lockout: an owner who has not enrolled is NOT refused at sign-in; the
//     session is marked `enroll_required` so enrollment is reachable. A factor
//     only becomes active at confirm, and confirm issues the recovery codes in
//     the same step — there is never an active factor with no way back in.
//   • Single use: an accepted TOTP step and a used recovery code are each
//     claimed with a conditional UPDATE, so two concurrent submissions of the
//     same code cannot both succeed.
//   • Failure ceiling (NIST SP 800-63B §5.2.2, ≤100): consecutive failed checks
//     are counted on the factor row. At the ceiling, authenticator codes are
//     refused until a recovery code is used — a guessing attacker is stopped
//     outright, and the owner still has a way in. Any success resets the count.
//     This sits under the per-request rate limits (lib/auth-rate-limit.ts),
//     which bound the SPEED of guessing; this bounds the TOTAL.
//
// Secrets never leave this module in logs or errors: nothing here logs, and no
// return value carries a secret except the enrollment secret and the one-time
// recovery codes, which exist to be shown to their owner.
//
// DI pattern (like lib/billing/grants.ts): the catalog handle and the key are
// passed in, so this unit-tests against an in-memory database.

import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { getGrantByUserId, isGrantLive } from "@/lib/billing/grants";
import { openSecret, sealSecret } from "@/lib/crypto/secret-box";
import {
  generateRecoveryCodeSet,
  hashRecoveryCode,
  looksLikeRecoveryCode,
} from "@/lib/mfa/recovery-codes";
import {
  buildOtpauthUri,
  generateTotpSecret,
  looksLikeTotpCode,
  verifyTotpCode,
} from "@/lib/mfa/totp";
import {
  userMfaRecoveryCodes,
  userMfaTotp,
  type UserMfaTotp,
} from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";

/** Consecutive failed checks before authenticator codes are refused. */
export const MFA_MAX_CONSECUTIVE_FAILURES = 100;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** The account's TOTP factor row, confirmed or not. */
export async function getTotpFactor(
  db: AppDatabase,
  userId: string,
): Promise<UserMfaTotp | undefined> {
  const rows = await db
    .select()
    .from(userMfaTotp)
    .where(eq(userMfaTotp.userId, userId))
    .limit(1)
    .all();
  return rows[0];
}

/** True when the account has a CONFIRMED (active) second factor. */
export async function isMfaActive(db: AppDatabase, userId: string): Promise<boolean> {
  return Boolean((await getTotpFactor(db, userId))?.confirmedAt);
}

/** True when policy requires MFA for this account: a live OWNER grant. */
export async function isMfaRequired(
  db: AppDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const grant = await getGrantByUserId(db, userId);
  return grant?.type === "owner" && isGrantLive(grant, now);
}

export type BeginEnrollmentResult =
  | { status: "already_active" }
  | { status: "started"; secret: string; otpauthUri: string };

/**
 * Start (or restart) enrollment: a fresh secret, sealed and stored UNCONFIRMED.
 * Restarting replaces an unconfirmed secret; an ACTIVE factor is never
 * overwritten here (turning MFA off or rotating it is a later, audited slice).
 */
export async function beginTotpEnrollment(
  db: AppDatabase,
  input: { userId: string; key: Buffer; issuer: string; accountLabel: string },
): Promise<BeginEnrollmentResult> {
  const existing = await getTotpFactor(db, input.userId);
  if (existing?.confirmedAt) return { status: "already_active" };

  const secret = generateTotpSecret();
  const sealed = sealSecret(secret, input.key, input.userId);
  await db
    .insert(userMfaTotp)
    .values({
      id: newId("mfa"),
      userId: input.userId,
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
    })
    .onConflictDoUpdate({
      target: userMfaTotp.userId,
      set: {
        secretCiphertext: sealed.ciphertext,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
        lastUsedStep: null,
        failedAttempts: 0,
      },
      // Never replace a factor that was confirmed between the read and here.
      setWhere: isNull(userMfaTotp.confirmedAt),
    })
    .run();

  const stored = await getTotpFactor(db, input.userId);
  if (stored?.secretCiphertext !== sealed.ciphertext) {
    return { status: "already_active" };
  }
  return {
    status: "started",
    secret,
    otpauthUri: buildOtpauthUri({
      issuer: input.issuer,
      accountLabel: input.accountLabel,
      secret,
    }),
  };
}

export type ConfirmEnrollmentResult =
  | { status: "not_started" }
  | { status: "already_active" }
  | { status: "invalid_code" }
  | { status: "confirmed"; recoveryCodes: string[] };

/**
 * Prove the authenticator works with its first code, activate the factor, and
 * issue the recovery codes — one step, so an active factor always has them.
 */
export async function confirmTotpEnrollment(
  db: AppDatabase,
  input: { userId: string; key: Buffer; code: string; now?: Date },
): Promise<ConfirmEnrollmentResult> {
  const now = input.now ?? new Date();
  const factor = await getTotpFactor(db, input.userId);
  if (!factor) return { status: "not_started" };
  if (factor.confirmedAt) return { status: "already_active" };

  const check = await verifyTotpCode({
    secret: openFactorSecret(factor, input.key),
    code: input.code,
    lastUsedStep: factor.lastUsedStep,
    now,
  });
  if (!check.valid) return { status: "invalid_code" };

  // Atomic claim: still unconfirmed, and still the SAME secret the code was
  // checked against (a restart in between must not be confirmed by an old code).
  const claimed = await db
    .update(userMfaTotp)
    .set({ confirmedAt: now, lastUsedStep: check.step, failedAttempts: 0 })
    .where(
      and(
        eq(userMfaTotp.userId, input.userId),
        isNull(userMfaTotp.confirmedAt),
        eq(userMfaTotp.secretCiphertext, factor.secretCiphertext),
      ),
    )
    .run();
  if (claimed.rowsAffected !== 1) return { status: "invalid_code" };

  const { codes, hashes } = generateRecoveryCodeSet();
  await db
    .delete(userMfaRecoveryCodes)
    .where(eq(userMfaRecoveryCodes.userId, input.userId))
    .run();
  await db
    .insert(userMfaRecoveryCodes)
    .values(
      hashes.map((codeHash) => ({
        id: newId("rc"),
        userId: input.userId,
        codeHash,
      })),
    )
    .run();
  return { status: "confirmed", recoveryCodes: codes };
}

export type VerifyFactorResult =
  | { status: "not_enrolled" }
  | { status: "invalid" }
  | { status: "totp_locked" }
  | { status: "verified"; method: "totp" | "recovery_code" };

/**
 * Check a submitted code — an authenticator code or a recovery code — against
 * the account's ACTIVE factor. Every failure counts toward the ceiling; every
 * success resets it.
 *
 * `getKey` is a thunk and is called ONLY for an authenticator code. Recovery
 * codes are hashes and need no key, so a missing or wrong encryption key can
 * never take away the recovery path — it only breaks authenticator codes, loudly.
 */
export async function verifySecondFactor(
  db: AppDatabase,
  input: { userId: string; getKey: () => Buffer; code: string; now?: Date },
): Promise<VerifyFactorResult> {
  const factor = await getTotpFactor(db, input.userId);
  if (!factor?.confirmedAt) return { status: "not_enrolled" };

  if (looksLikeRecoveryCode(input.code)) {
    const used = await db
      .update(userMfaRecoveryCodes)
      .set({ usedAt: input.now ?? new Date() })
      .where(
        and(
          eq(userMfaRecoveryCodes.userId, input.userId),
          eq(userMfaRecoveryCodes.codeHash, hashRecoveryCode(input.code)),
          isNull(userMfaRecoveryCodes.usedAt),
        ),
      )
      .run();
    if (used.rowsAffected === 1) {
      await resetFailures(db, input.userId);
      return { status: "verified", method: "recovery_code" };
    }
    await recordFailure(db, input.userId);
    return { status: "invalid" };
  }

  if (factor.failedAttempts >= MFA_MAX_CONSECUTIVE_FAILURES) {
    return { status: "totp_locked" };
  }

  if (looksLikeTotpCode(input.code)) {
    const check = await verifyTotpCode({
      secret: openFactorSecret(factor, input.getKey()),
      code: input.code,
      lastUsedStep: factor.lastUsedStep,
      now: input.now,
    });
    // The claim is what makes the code single-use: a concurrent submission of
    // the same code finds last_used_step already at this step and matches 0 rows.
    if (check.valid && (await claimTotpStep(db, input.userId, check.step))) {
      return { status: "verified", method: "totp" };
    }
  }

  await recordFailure(db, input.userId);
  return { status: "invalid" };
}

export type SignInFactorResult =
  | { status: "not_required" }
  | { status: "enroll_required" }
  | { status: "code_required" }
  | { status: "invalid" }
  | { status: "totp_locked" }
  | { status: "verified"; method: "totp" | "recovery_code" };

/**
 * The sign-in decision, run by lib/auth.ts::authorize AFTER the password has
 * been verified and BEFORE the tenant is resolved.
 *
 * `getKey` is a thunk: accounts without an active factor never need the
 * encryption key, so a key problem can never stop them signing in.
 */
export async function resolveSignInFactor(
  db: AppDatabase,
  input: { userId: string; code?: string | null; getKey: () => Buffer; now?: Date },
): Promise<SignInFactorResult> {
  if (!(await isMfaActive(db, input.userId))) {
    return (await isMfaRequired(db, input.userId, input.now))
      ? { status: "enroll_required" }
      : { status: "not_required" };
  }
  const code = (input.code ?? "").trim();
  if (code.length === 0) return { status: "code_required" };
  const result = await verifySecondFactor(db, {
    userId: input.userId,
    getKey: input.getKey,
    code,
    now: input.now,
  });
  // An active factor cannot be "not enrolled" a moment later unless it was
  // removed mid-sign-in; treat that as a failed check, never as a pass.
  return result.status === "not_enrolled" ? { status: "invalid" } : result;
}

/** Number of unused recovery codes — for the owner to know when to renew. */
export async function remainingRecoveryCodes(
  db: AppDatabase,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ id: userMfaRecoveryCodes.id })
    .from(userMfaRecoveryCodes)
    .where(
      and(eq(userMfaRecoveryCodes.userId, userId), isNull(userMfaRecoveryCodes.usedAt)),
    )
    .all();
  return rows.length;
}

function openFactorSecret(factor: UserMfaTotp, key: Buffer): string {
  return openSecret(
    {
      ciphertext: factor.secretCiphertext,
      iv: factor.secretIv,
      tag: factor.secretTag,
    },
    key,
    factor.userId,
  );
}

/** Record `step` as used, only if it is newer than the last one. */
export async function claimTotpStep(
  db: AppDatabase,
  userId: string,
  step: number,
): Promise<boolean> {
  const result = await db
    .update(userMfaTotp)
    .set({ lastUsedStep: step, failedAttempts: 0 })
    .where(
      and(
        eq(userMfaTotp.userId, userId),
        isNotNull(userMfaTotp.confirmedAt),
        or(isNull(userMfaTotp.lastUsedStep), lt(userMfaTotp.lastUsedStep, step)),
      ),
    )
    .run();
  return result.rowsAffected === 1;
}

async function recordFailure(db: AppDatabase, userId: string): Promise<void> {
  await db
    .update(userMfaTotp)
    .set({ failedAttempts: sql`${userMfaTotp.failedAttempts} + 1` })
    .where(eq(userMfaTotp.userId, userId))
    .run();
}

async function resetFailures(db: AppDatabase, userId: string): Promise<void> {
  await db
    .update(userMfaTotp)
    .set({ failedAttempts: 0 })
    .where(eq(userMfaTotp.userId, userId))
    .run();
}
