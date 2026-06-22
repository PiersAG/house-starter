// Password hashing and policy enforcement for the house-starter template.
//
// Pure logic only — importing this module has NO side effects and opens no
// database connection. Both the signup route and the credentials authorize()
// callback depend on these helpers, and they are exercised directly by unit
// tests (this module is included in coverage).

import bcrypt from "bcryptjs";

/** Minimum password length (NIST SP 800-63B Rev 4: 8 char floor, 15 recommended). */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * A small embedded breached-password denylist. The quality baseline requires
 * screening new passwords against a breached-password list on account creation
 * "regardless of tier". A full HaveIBeenPwned k-anonymity lookup needs network
 * access that the starter avoids in its test environment, so we screen against
 * the most common breached passwords offline. Comparison is case-insensitive.
 */
const BREACHED_PASSWORDS = new Set(
  [
    "password",
    "password1",
    "password123",
    "12345678",
    "123456789",
    "1234567890",
    "qwerty123",
    "qwertyuiop",
    "111111111",
    "iloveyou",
    "admin123",
    "letmein123",
    "welcome123",
    "monkey123",
    "abc12345",
    "football",
    "baseball",
    "sunshine",
    "princess",
    "dragon123",
    "passw0rd",
    "trustno1",
    "starwars",
    "whatever",
    "changeme",
  ].map((p) => p.toLowerCase()),
);

/**
 * Validate a candidate password against the policy.
 * Returns a human-readable error message describing what to fix, or `null` when
 * the password is acceptable. The message format is intentionally actionable
 * (forms baseline: "say what went wrong and what to do about it").
 */
export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (BREACHED_PASSWORDS.has(password.toLowerCase())) {
    return "This password has appeared in a known data breach. Please choose a different one.";
  }
  return null;
}

/** True when the password fails the policy. Convenience wrapper. */
export function isBreachedPassword(password: string): boolean {
  return BREACHED_PASSWORDS.has(String(password).toLowerCase());
}

/** Hash a plaintext password with bcrypt (unique per-hash salt, cost 10). */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

/** Constant-time-ish comparison of a plaintext password against a stored hash. */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}
