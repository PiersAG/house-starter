// Sign-in plumbing for the second factor (SEC.15, Slice 1).
//
// Two small things the sign-in path needs, kept out of the auth kernel so they
// are unit-tested to 100% on their own:
//
//   1. Reading the submitted code. Auth.js turns every credential into a string
//      before authorize() sees it, so a form with no code field sends the
//      literal "undefined" or "null". Those must mean "no code", or every
//      ordinary sign-in would spend the MFA rate-limit budget on a phantom code.
//
//   2. Telling the login form WHY a sign-in stopped. A refusal thrown inside
//      authorize() reaches the login action wrapped by Auth.js (two levels
//      down, as a CallbackRouteError's cause). The form must distinguish "now
//      enter your code" and "that code was wrong" from "wrong password" — so,
//      like the rate-limit refusal in lib/auth-rate-limit.ts, the reason travels
//      as a marker string that survives re-wrapping.

/** Why a sign-in stopped at the second factor. */
export const MFA_SIGN_IN_REASONS = [
  "mfa_code_required",
  "mfa_code_invalid",
  "mfa_totp_locked",
] as const;
export type MfaSignInReason = (typeof MFA_SIGN_IN_REASONS)[number];

/** Thrown from authorize() when the password was right but the factor is not settled. */
export class MfaSignInError extends Error {
  constructor(readonly reason: MfaSignInReason) {
    super(reason);
    this.name = "MfaSignInError";
  }
}

/**
 * The code a sign-in attempt carried, or "" for none. Strips whitespace and
 * treats Auth.js's stringified absence ("undefined" / "null") as none.
 */
export function submittedCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  return trimmed === "undefined" || trimmed === "null" ? "" : trimmed;
}

/**
 * The second-factor reason carried by `error` or anything in its cause chain,
 * or null. Bounded walk, same shape as isAuthRateLimitError.
 */
export function mfaSignInReason(error: unknown): MfaSignInReason | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof MfaSignInError) return current.reason;
    if (!(current instanceof Error)) return null;
    const message = current.message;
    const found = MFA_SIGN_IN_REASONS.find((reason) => message.includes(reason));
    if (found) return found;
    const cause: unknown = current.cause;
    current =
      cause && typeof cause === "object" && "err" in cause
        ? (cause as { err: unknown }).err
        : cause;
  }
  return null;
}
