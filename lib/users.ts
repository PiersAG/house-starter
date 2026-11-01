// User repository + registration service for the house-starter template.
//
// These functions take the Drizzle database as an explicit argument (dependency
// injection) so they can be unit-tested against an in-memory database without
// importing the live singleton in lib/db.ts. This module is included in
// coverage and is exercised directly by tests/unit/users.test.ts.

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
}

/** Insert a user row and return the persisted record (id generated here). */
export async function createUser(
  db: AppDatabase,
  input: CreateUserInput,
): Promise<User> {
  const id = crypto.randomUUID();
  const rows = await db
    .insert(users)
    .values({
      id,
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      name: input.name ?? null,
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
 * emails, hash the password, and persist the user. Throws RegistrationError
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
  if (await getUserByEmail(db, input.email)) {
    throw new RegistrationError(
      "email_taken",
      "An account with this email already exists. Try signing in instead.",
    );
  }
  const passwordHash = await hashPassword(input.password);
  return await createUser(db, {
    email: fields.data.email,
    passwordHash,
    name: fields.data.name ?? null,
  });
}
