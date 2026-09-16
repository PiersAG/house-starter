// Encryption at rest for small account-level secrets (SEC.15 MFA, Slice 1).
//
// WHY THIS EXISTS
// ---------------
// A TOTP secret is not like a password: the server must be able to READ it back
// to check a code, so it cannot be hashed. A catalog dump that yielded the raw
// secrets would hand an attacker every enrolled account's second factor. So the
// secret is sealed with AES-256-GCM under a key that lives in the environment
// (MFA_ENCRYPTION_KEY), never in the database — a stolen database alone is not
// enough.
//
// GCM gives integrity as well as secrecy: a ciphertext, IV or tag that has been
// altered fails to open rather than decrypting to garbage. The caller passes
// ASSOCIATED DATA (the owning user id) so a sealed secret copied onto another
// account's row also fails to open — the row cannot be transplanted.
//
// Node.js runtime only (node:crypto). Never imported by auth.config.ts or the
// Edge middleware.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The environment variable holding the base64-encoded 32-byte key. */
export const MFA_KEY_ENV = "MFA_ENCRYPTION_KEY";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96-bit IV — the GCM standard size. Fresh per seal, never reused. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A sealed value, every part base64-encoded for text columns. */
export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Raised when the key is missing or malformed. The message names the variable
 * and never the value.
 */
export class SecretBoxKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxKeyError";
  }
}

/**
 * Read and validate the key from the environment. Fails loudly — there is no
 * fallback key, ever, for the same reason there is no fallback AUTH_SECRET.
 */
export function loadSecretBoxKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = (env[MFA_KEY_ENV] ?? "").trim();
  if (raw.length === 0) {
    throw new SecretBoxKeyError(
      `${MFA_KEY_ENV} is not set. Generate one with: openssl rand -base64 32`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxKeyError(
      `${MFA_KEY_ENV} must be ${KEY_BYTES} bytes, base64-encoded ` +
        `(openssl rand -base64 32).`,
    );
  }
  return key;
}

/** Seal `plaintext` under `key`, bound to `associatedData`. */
export function sealSecret(
  plaintext: string,
  key: Buffer,
  associatedData: string,
): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Open a sealed value. Throws when the key is wrong, the associated data does
 * not match, or any part has been altered — never returns a wrong plaintext.
 */
export function openSecret(
  sealed: SealedSecret,
  key: Buffer,
  associatedData: string,
): string {
  const tag = Buffer.from(sealed.tag, "base64");
  if (tag.length !== TAG_BYTES) {
    // Node would otherwise accept a truncated tag, which weakens the check.
    throw new Error("Sealed secret has an invalid authentication tag.");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(sealed.iv, "base64"),
    { authTagLength: TAG_BYTES },
  );
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
