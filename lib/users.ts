// User repository + registration service for the house-starter template.
//
// These functions take the Drizzle database as an explicit argument (dependency
// injection) so they can be unit-tested against an in-memory database without
// importing the live singleton in lib/db.ts. This module is included in
// coverage and is exercised directly by tests/unit/users.test.ts.

import "server-only";

import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { users, type User } from "@/lib/schema";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
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
  now?: Date;
}

/** How long a sign-up that never finished is kept before the retention job erases it. */
export const PENDING_SIGNUP_EXPIRY_MS = 60 * 60 * 1000;

/** True when the account is a sign-up whose database is not yet ready. */
export function isPendingSignup(user: { signupPendingSince?: Date | null } | null | undefined): boolean {
  return Boolean(user?.signupPendingSince);
}

/** Insert a user row and return the persisted record (id generated here). */
export async function createUser(
  db: AppDatabase,
  input: CreateUserInput,
): Promise<User> {
  const id = crypto.randomUUID();
  const now = input.now ?? new Date();
  const rows = await db
    .insert(users)
    .values({
      id,
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      name: input.name ?? null,
      // Off until provisioned: `deactivatedAt` is what sign-in refuses
      // (lib/auth.ts authorize → isDeactivated), and `deletionDueAt` lets the
      // retention job erase a sign-up that never finished, with its database.
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
  if (existing) {
    throw new RegistrationError(
      "email_taken",
      isPendingSignup(existing)
        ? "An account with this email is still being set up. Please try again in an hour."
        : "An account with this email already exists. Try signing in instead.",
    );
  }
  const passwordHash = await hashPassword(input.password);
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
