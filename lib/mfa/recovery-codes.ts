// Recovery codes (SEC.15 MFA, Slice 1) — the way back in when the phone is lost.
//
// Recovery ships WITH enrollment, never after it: the moment an account's second
// factor becomes active it already holds ten of these, so turning MFA on can
// never create an account with no route back in.
//
//   • Generated from the operating system's CSPRNG (node:crypto randomBytes).
//   • 12 characters from a 32-letter alphabet = 60 bits each. Far beyond online
//     guessing under the verify rate limits, which is why a fast hash (SHA-256)
//     is sufficient — the same reasoning as the password-reset token hash.
//   • The alphabet drops 0/O and 1/I so a code read off paper types back correctly.
//   • Only the HASH is stored. The plaintext is returned exactly once, at
//     enrollment, for the person to write down.
//   • Single use — consumption is an atomic claim in lib/mfa/enrollment.ts.
//
// Pure: no database, no environment.

import { createHash, randomBytes } from "node:crypto";

export const RECOVERY_CODE_COUNT = 10;

/** 2–9 plus A–Z without I and O: exactly 32 symbols, no 0/O or 1/I confusion. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const GROUP = 4;
const GROUPS = 3;
const CODE_LENGTH = GROUP * GROUPS;

const NORMALIZED_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

/** One code, formatted for humans: "ABCD-EFGH-JKMN". */
export function generateRecoveryCode(): string {
  // 32 symbols → each random byte's low 5 bits index the alphabet uniformly.
  const bytes = randomBytes(CODE_LENGTH);
  let raw = "";
  for (const byte of bytes) raw += ALPHABET[byte & 0x1f];
  const groups: string[] = [];
  for (let i = 0; i < CODE_LENGTH; i += GROUP) groups.push(raw.slice(i, i + GROUP));
  return groups.join("-");
}

/** Upper-case and drop separators/spaces, so "abcd efgh-jkmn" matches. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, "");
}

/** True when `code` has the shape of a recovery code after normalising. */
export function looksLikeRecoveryCode(code: string): boolean {
  return NORMALIZED_PATTERN.test(normalizeRecoveryCode(code));
}

/** SHA-256 of the normalised code, hex. The only form that is ever stored. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

/** A fresh set: plaintext for the person (shown once) and hashes for storage. */
export function generateRecoveryCodeSet(count: number = RECOVERY_CODE_COUNT): {
  codes: string[];
  hashes: string[];
} {
  const unique = new Set<string>();
  while (unique.size < count) unique.add(generateRecoveryCode());
  const codes = [...unique];
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
