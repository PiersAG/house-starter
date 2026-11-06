// Refusing passwords known from data breaches (app-business-core issue 356, the
// "breached-password (HIBP)" part; NIST SP 800-63B Rev 4 § 3.1.1.2: a new password is
// compared against "passwords obtained from previous breach corpuses").
//
// HOW, WITHOUT SENDING THE PASSWORD. Have I Been Pwned's free Pwned Passwords range
// API (https://haveibeenpwned.com/API/v3#PwnedPasswords, no key, no charge) is asked
// for every breached-password hash that begins with the same 5 characters as this
// password's SHA-1 hash. Only those 5 characters leave the server — never the
// password, never its full hash, never who is signing up — and the match is made
// here, against the list that comes back (k-anonymity). `Add-Padding: true` asks the
// service to pad every answer with dummy entries (count 0, ignored here), so the
// answer's size does not hint at the prefix either.
//
// IF THE SERVICE CANNOT BE REACHED the password is accepted — the embedded list in
// lib/password.ts has already refused the commonest ones — and a security event is
// logged, so a long outage is visible. A sign-up is never blocked by someone else's
// outage. The lookup gives up after TIMEOUT_MS.
//
// TESTS. In the safe test environment (lib/auth-rate-limit.ts inSafeTestEnvironment:
// never on a deployed app) the lookup is skipped, so unit and browser tests do not
// depend on the network; PASSWORD_BREACH_CHECK=range forces the real lookup there
// (the bundle's proof does). On a deployed app the lookup always runs.

import "server-only";

import { createHash } from "node:crypto";
import { inSafeTestEnvironment } from "@/lib/auth-rate-limit";
import { logSecurityEvent } from "@/lib/security-log";

export const RANGE_URL = "https://api.pwnedpasswords.com/range/";
export const TIMEOUT_MS = 2_500;
export const BREACHED_MESSAGE =
  "This password has appeared in a known data breach. Please choose a different one.";

export type BreachCheckMode = "range" | "skipped";

export type BreachEnv = {
  VERCEL_ENV?: string;
  RATE_LIMIT_ALLOW_IN_MEMORY?: string;
  PASSWORD_BREACH_CHECK?: string;
};

/** Whether the range lookup runs here: always on a deployed app. */
export function breachCheckMode(env: BreachEnv = process.env as BreachEnv): BreachCheckMode {
  if (env.PASSWORD_BREACH_CHECK === "range") return "range";
  return inSafeTestEnvironment(env) ? "skipped" : "range";
}

/** The SHA-1 of the password, upper-case hex, split into the 5 sent and the 35 kept. */
export function hashParts(password: string): { prefix: string; suffix: string } {
  const hex = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}

/** How many breaches the range answer lists for `suffix` (0 when absent or padding). */
export function countInRange(body: string, suffix: string): number {
  for (const line of body.split(/\r?\n/)) {
    const [hash, count] = line.trim().split(":");
    if (hash?.toUpperCase() === suffix) {
      const n = Number.parseInt(count ?? "", 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
  }
  return 0;
}

export type BreachResult =
  | { status: "breached"; count: number }
  | { status: "clean" }
  | { status: "unavailable" }
  | { status: "skipped" };

export interface BreachDeps {
  fetch?: typeof fetch;
  env?: BreachEnv;
}

/** Look the password up by its hash prefix. Never throws; never sends the password. */
export async function checkBreachedPassword(
  password: string,
  deps: BreachDeps = {},
): Promise<BreachResult> {
  if (breachCheckMode(deps.env) === "skipped") return { status: "skipped" };
  const doFetch = deps.fetch ?? fetch;
  const { prefix, suffix } = hashParts(password);
  try {
    const res = await doFetch(`${RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "house-starter-password-check" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      logSecurityEvent("password_breach_check_unavailable", { reason: `answered ${res.status}` });
      return { status: "unavailable" };
    }
    const count = countInRange(await res.text(), suffix);
    return count > 0 ? { status: "breached", count } : { status: "clean" };
  } catch (error) {
    logSecurityEvent("password_breach_check_unavailable", {
      reason: error instanceof Error ? error.name : "error",
    });
    return { status: "unavailable" };
  }
}

/**
 * The error to show for a password found in a breach, or null. Used wherever a new
 * password is set: sign-up, password reset and password change.
 */
export async function breachedPasswordError(
  password: string,
  where: "signup" | "reset" | "change",
  deps: BreachDeps = {},
): Promise<string | null> {
  const result = await checkBreachedPassword(password, deps);
  if (result.status !== "breached") return null;
  logSecurityEvent("password_breached_refused", { where });
  return BREACHED_MESSAGE;
}
