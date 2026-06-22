// User repository + registration service for the house-starter template.
//
// These functions take the Drizzle database as an explicit argument (dependency
// injection) so they can be unit-tested against an in-memory database without
// importing the live singleton in lib/db.ts. This module is included in
// coverage and is exercised directly by tests/unit/users.test.ts.

import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users, type User } from "@/lib/schema";
import { hashPassword, validatePasswordStrength } from "@/lib/password";

/** The Drizzle database type used throughout the app (better-sqlite3 driver). */
export type AppDatabase = BetterSQLite3Database<Record<string, never>>;

/** Normalise an email for storage and lookup: trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Look up a single user by (normalised) email. Returns undefined when absent. */
export function getUserByEmail(
  db: AppDatabase,
  email: string,
): User | undefined {
  const rows = db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1)
    .all();
  return rows[0];
}

/** Look up a single user by id. Returns undefined when absent. */
export function getUserById(db: AppDatabase, id: string): User | undefined {
  const rows = db.select().from(users).where(eq(users.id, id)).limit(1).all();
  return rows[0];
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  name?: string | null;
}

/** Insert a user row and return the persisted record (id generated here). */
export function createUser(db: AppDatabase, input: CreateUserInput): User {
  const id = crypto.randomUUID();
  const rows = db
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
export type RegistrationErrorCode = "weak_password" | "email_taken";

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
  if (getUserByEmail(db, input.email)) {
    throw new RegistrationError(
      "email_taken",
      "An account with this email already exists. Try signing in instead.",
    );
  }
  const passwordHash = await hashPassword(input.password);
  return createUser(db, {
    email: input.email,
    passwordHash,
    name: input.name ?? null,
  });
}
