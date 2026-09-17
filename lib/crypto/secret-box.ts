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

// ── tenant database tokens ───────────────────────────────────────────────────
//
// The catalog's `tenants.db_auth_token` holds every tenant database's
// credential, so a plaintext column would turn one catalog leak into a leak of
// every tenant. The token is sealed under the same MFA_ENCRYPTION_KEY and packed
// into ONE text value so the column shape does not change.
//
// The associated data is the tenant id (domain-separated from the MFA owner
// ids), so a sealed token copied onto another tenant's row fails to open.
//
// There is no plaintext fallback: a value that is not `v1.`-sealed, or that
// does not open, throws. Pre-seal rows are wiped and re-provisioned, never read.

const TENANT_TOKEN_VERSION = "v1";
const TENANT_TOKEN_AAD_PREFIX = "tenant-db-token:";

/** Raised when a stored tenant token is not a sealed value that opens. */
export class TenantTokenSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantTokenSealError";
  }
}

function toB64url(b64: string): string {
  return Buffer.from(b64, "base64").toString("base64url");
}

function fromB64url(part: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) {
    throw new TenantTokenSealError("Sealed tenant token is malformed.");
  }
  return Buffer.from(part, "base64url").toString("base64");
}

/** Seal a tenant database token as `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function sealTenantToken(
  token: string,
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const sealed = sealSecret(
    token,
    loadSecretBoxKey(env),
    TENANT_TOKEN_AAD_PREFIX + tenantId,
  );
  return [
    TENANT_TOKEN_VERSION,
    toB64url(sealed.iv),
    toB64url(sealed.tag),
    toB64url(sealed.ciphertext),
  ].join(".");
}

/**
 * Open a value written by sealTenantToken. Throws TenantTokenSealError when the
 * value is not sealed, is malformed, or fails to open (wrong key, wrong tenant,
 * altered) — never returns the stored value as if it were plaintext.
 */
export function openTenantToken(
  sealed: string,
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== TENANT_TOKEN_VERSION) {
    throw new TenantTokenSealError(
      `Stored token for tenant ${JSON.stringify(tenantId)} is not a sealed ` +
        `${TENANT_TOKEN_VERSION} value — refusing to use it.`,
    );
  }
  const key = loadSecretBoxKey(env);
  const box: SealedSecret = {
    iv: fromB64url(parts[1]),
    tag: fromB64url(parts[2]),
    ciphertext: fromB64url(parts[3]),
  };
  try {
    return openSecret(box, key, TENANT_TOKEN_AAD_PREFIX + tenantId);
  } catch {
    throw new TenantTokenSealError(
      `Stored token for tenant ${JSON.stringify(tenantId)} failed to open ` +
        "(wrong key, wrong tenant, or altered).",
    );
  }
}
