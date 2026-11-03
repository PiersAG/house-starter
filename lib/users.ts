// User repository + registration service for the house-starter template.
//
// These functions take the Drizzle database as an explicit argument (dependency
// injection) so they can be unit-tested against an in-memory database without
// importing the live singleton in lib/db.ts. This module is included in
// coverage and is exercised directly by tests/unit/users.test.ts.

import "server-only";

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { passwordResetTokens, users, type User } from "@/lib/schema";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
import { SIGNUP_FAILED_MESSAGE } from "@/lib/signup-failure";
import { z } from "zod";
import {
  emailField,
  firstIssue,
  newPasswordField,
  optionalNameField,
} from "@/lib/validation/input";

/** The Drizzle database type used throughout the app (libSQL driver). */
export type AppDatabase = LibSQLDatabase<Record<string, never>>;

/** Normalise an email for storage and lookup: trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Look up a single user by (normalised) email. Returns undefined when absent. */
export async function getUserByEmail(
  db: AppDatabase,
  email: string,
): Promise<User | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1)
    .all();
  return rows[0];
}

/** Look up a single user by id. Returns undefined when absent. */
export async function getUserById(
  db: AppDatabase,
  id: string,
): Promise<User | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .all();
  return rows[0];
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  name?: string | null;
  /**
   * Create the account SWITCHED OFF, as a sign-up still being set up
   * (app-business-core issue 358): sign-in refuses it until
   * lib/tenant/signup-provisioning.ts switches it on once its database is
   * ready. registerUser (every sign-up) passes true; the seeded owner
   * (lib/owner-seed.ts) does not, as its tenant is made at first sign-in.
   */
  pendingSignup?: boolean;
}

/**
 * How long a sign-up that never finished is kept before the background clean-up
 * (the retention job) erases it. Timing only: nobody is ever told to wait it out
 * — a retry with the same email removes the unfinished account at once
 * (registerUser), CEO ruling 2026-11-03.
 */
export const PENDING_SIGNUP_EXPIRY_MS = 60 * 60 * 1000;

/** What a sign-up is told when a switched-on (or closed) account holds its address. */
export const ACCOUNT_EXISTS_MESSAGE = "An account with this email already exists. Try signing in instead.";

/** True when the account is a sign-up whose database is not yet ready. */
export function isPendingSignup(user: { signupPendingSince: Date | null }): boolean {
  return user.signupPendingSince !== null;
}

/**
 * A sign-up that never finished and may be removed by a retry: never switched
 * on (`signupPendingSince` set), switched off, and linked to no tenant.
 */
export function isUnfinishedSignup(
  user: Pick<User, "signupPendingSince" | "deactivatedAt" | "tenantId">,
): boolean {
  return user.signupPendingSince !== null && user.deactivatedAt !== null && user.tenantId === null;
}

/**
 * A retry could not remove the unfinished sign-up holding its address: another
 * retry at the same moment removed it first, or the account changed under it.
 * Not a RegistrationError: the person gets the fixed "please try again"
 * (lib/signup-failure.ts), as for any other failed sign-up.
 */
export class SignupRetryError extends Error {
  constructor() {
    super(SIGNUP_FAILED_MESSAGE);
    this.name = "SignupRetryError";
  }
}

/**
 * Remove the unfinished sign-up `userId`, in ONE atomic batch whose account
 * delete is conditional on the account still being an unfinished sign-up —
 * so of two retries at the same moment exactly one removes it, and an account
 * switched on in the meantime is never removed. Its password-reset tokens go in
 * the same batch (the only rows an account that never signed in can have).
 * The account only: the database its sign-up may have made stays recorded in
 * tenant_orphans, which the rollback or the factory's sweep removes
 * (lib/tenant/signup-provisioning.ts). Throws SignupRetryError when it lost.
 */
async function removeUnfinishedSignup(db: AppDatabase, userId: string): Promise<void> {
  const unfinished = and(
    eq(users.id, userId),
    isNotNull(users.signupPendingSince),
    isNotNull(users.deactivatedAt),
    isNull(users.tenantId),
  );
  const [, removed] = await db.batch([
    db
      .delete(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          sql`exists (select 1 from users where users.id = ${userId} and users.signup_pending_since is not null and users.deactivated_at is not null and users.tenant_id is null)`,
        ),
      ),
    db.delete(users).where(unfinished),
  ]);
  if (removed.rowsAffected !== 1) throw new SignupRetryError();
}

/** Insert a user row and return the persisted record (id generated here). */
export async function createUser(
  db: AppDatabase,
  input: CreateUserInput,
): Promise<User> {
  const id = crypto.randomUUID();
  const now = new Date();
  const rows = await db
    .insert(users)
    .values({
      id,
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      name: input.name ?? null,
      // Off until provisioned: sign-in refuses it (lib/auth.ts authorize →
      // isDeactivated, which refuses `deactivatedAt` or `signupPendingSince`),
      // and `deletionDueAt` lets a sign-up that never finished be erased.
      ...(input.pendingSignup
        ? {
            signupPendingSince: now,
            deactivatedAt: now,
            deletionDueAt: new Date(now.getTime() + PENDING_SIGNUP_EXPIRY_MS),
          }
        : {}),
    })
    .returning()
    .all();
  return rows[0];
}

/** Discriminated error codes for registration failures. */
export type RegistrationErrorCode = "weak_password" | "email_taken" | "invalid_input";

/** Thrown by {@link registerUser} when registration cannot proceed. */
export class RegistrationError extends Error {
  constructor(
    public readonly code: RegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

const registrationFields = z.object({
  email: emailField,
  password: newPasswordField,
  name: z.union([z.null(), optionalNameField]).optional(),
});

export interface RegisterUserInput {
  email: string;
  password: string;
  name?: string | null;
}

/**
 * End-to-end account creation: enforce password policy, reject duplicate
 * emails, hash the password, and persist the user — switched off, as a
 * sign-up being set up, until provisionNewAccount switches it on. Throws RegistrationError
 * with an actionable message on policy/uniqueness failures.
 *
 * A retry works at once (CEO ruling 2026-11-03): when the address belongs to a
 * sign-up that never finished (isUnfinishedSignup), that account is removed and
 * this sign-up goes on afresh. A switched-on or closed account is never removed.
 * Throws SignupRetryError when another retry removed it first.
 */
export async function registerUser(
  db: AppDatabase,
  input: RegisterUserInput,
): Promise<User> {
  const strengthError = validatePasswordStrength(input.password);
  if (strengthError) {
    throw new RegistrationError("weak_password", strengthError);
  }
  // The same field rules every door uses (lib/validation/input.ts, #442, #758),
  // here too, so a caller that skipped its own schema still cannot store an
  // over-long password, a malformed address or a name carrying markup or a link.
  const fields = registrationFields.safeParse(input);
  if (!fields.success) {
    throw new RegistrationError("invalid_input", firstIssue(fields.error));
  }
  const existing = await getUserByEmail(db, input.email);
  if (existing && !isPendingSignup(existing)) {
    throw new RegistrationError("email_taken", ACCOUNT_EXISTS_MESSAGE);
  }
  const passwordHash = await hashPassword(input.password);
  if (existing) {
    // A sign-up that never finished holds the address. Removed now, so the
    // retry is not made to wait; one that is linked to a tenant (never made by
    // a sign-up) is not, and the person gets the fixed "please try again".
    if (!isUnfinishedSignup(existing)) throw new SignupRetryError();
    await removeUnfinishedSignup(db, existing.id);
  }
  // Every sign-up starts SWITCHED OFF (issue 358): the caller gives it its
  // database with provisionNewAccount, which switches it on only when that is
  // finished, so no failure at any point leaves a usable account with none.
  return await createUser(db, {
    email: fields.data.email,
    passwordHash,
    name: fields.data.name ?? null,
    pendingSignup: true,
  });
}
