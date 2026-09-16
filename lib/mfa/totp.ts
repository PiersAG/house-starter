// TOTP primitives (SEC.15 MFA, Slice 1) — authenticator-app codes.
//
// Thin, deliberate wrapper over otplib so the security decisions are written
// down in ONE place rather than re-chosen at every call site:
//
//   • Standard parameters only — SHA-1, 6 digits, 30-second steps. That is what
//     every authenticator app implements; anything else silently fails to scan.
//   • A ±1 step window (±30s) for clock drift between phone and server. Wider
//     windows multiply how many codes an attacker's guess can match.
//   • SINGLE USE. A code is accepted only if its time step is AFTER the last step
//     this account accepted. A code seen over a shoulder or replayed from a log
//     inside its 90-second life is refused. The caller persists the returned
//     step atomically (lib/mfa/enrollment.ts) — this module only decides.
//
// Pure: no database, no environment. `now` is injectable for tests.

import { generateSecret, generateURI, verify } from "otplib";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous, current and next step. */
const EPOCH_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS;

const CODE_PATTERN = /^\d{6}$/;

/** A new base32 secret — 20 random bytes (160 bits), the RFC 4226 recommendation. */
export function generateTotpSecret(): string {
  return generateSecret({ length: 20 });
}

/** The otpauth:// URI an authenticator app scans (rendered as a QR code). */
export function buildOtpauthUri(input: {
  issuer: string;
  accountLabel: string;
  secret: string;
}): string {
  return generateURI({
    issuer: input.issuer,
    label: input.accountLabel,
    secret: input.secret,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  });
}

/** Strip the spaces people type into codes ("123 456"). */
export function normalizeTotpCode(code: string): string {
  return code.replace(/\s+/g, "");
}

/** True when `code` has the shape of a TOTP code (six digits after normalising). */
export function looksLikeTotpCode(code: string): boolean {
  return CODE_PATTERN.test(normalizeTotpCode(code));
}

export type TotpCheck = { valid: true; step: number } | { valid: false };

/**
 * Check a code. Valid only when it matches within the ±1 step window AND its
 * step is strictly after `lastUsedStep` (null = never used).
 */
export async function verifyTotpCode(input: {
  secret: string;
  code: string;
  lastUsedStep: number | null;
  now?: Date;
}): Promise<TotpCheck> {
  const token = normalizeTotpCode(input.code);
  if (!CODE_PATTERN.test(token)) return { valid: false };

  const epoch = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const result = await verify({
    secret: input.secret,
    token,
    epoch,
    period: TOTP_PERIOD_SECONDS,
    digits: TOTP_DIGITS,
    epochTolerance: EPOCH_TOLERANCE_SECONDS,
    ...(input.lastUsedStep === null ? {} : { afterTimeStep: input.lastUsedStep }),
  });
  if (!result.valid) return { valid: false };
  // otplib's functional verify() types its result as TOTP-or-HOTP; with the
  // default TOTP strategy it is always the TOTP shape, which carries timeStep.
  return { valid: true, step: (result as { timeStep: number }).timeStep };
}
