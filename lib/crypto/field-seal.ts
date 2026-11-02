import "server-only";

// Sensitive fields sealed inside a payload, independently of the connection
// (app-business-core issue 445; Matt Murphy #64: "encrypt sensitive fields in
// your API payloads independently of the transport layer, so the data is
// protected even if the connection is compromised").
//
// HTTPS (enforced, HSTS) protects every byte the app sends. This adds a second
// layer for the cases where the connection is not the only thing in between:
// a payload sent to a native mobile app, another company's system, a queue or
// a webhook receiver, which may log or relay it. Each named field is replaced
// by an AES-256-GCM sealed value (lib/crypto/secret-box.ts), bound to the
// payload's purpose and the field's name, so a sealed value cannot be moved to
// another field or another kind of message and still open.
//
// The key is one the two ends share for that purpose — never the database or
// MFA key. A web page in the app's own browser tab gains nothing from it (the
// page would have to hold the key), so the template's own pages rely on HTTPS
// and on sending only the fields they need (lib/dto.ts). The build instructions
// require it for any mobile or system-to-system payload carrying a field
// config/data-classification.ts marks secret or personal.

import { openSecret, sealSecret, type SealedSecret } from "@/lib/crypto/secret-box";

export const FIELD_SEAL_VERSION = "aes-256-gcm/v1";

export type SealedField = SealedSecret & { sealed: typeof FIELD_SEAL_VERSION };

export type WithSealed<T, K extends keyof T> = Omit<T, K> & { [F in K]: SealedField };

const binding = (purpose: string, field: string) => `field-seal:v1:${purpose}:${field}`;

/** A copy of `payload` with each named field sealed under `key` for `purpose`. */
export function sealFields<T extends Record<string, unknown>, K extends keyof T & string>(
  payload: T,
  fields: readonly K[],
  key: Buffer,
  purpose: string,
): WithSealed<T, K> {
  const out: Record<string, unknown> = { ...payload };
  for (const field of fields) {
    const sealed = sealSecret(JSON.stringify(payload[field] ?? null), key, binding(purpose, field));
    out[field] = { sealed: FIELD_SEAL_VERSION, ...sealed };
  }
  return out as WithSealed<T, K>;
}

/**
 * The payload with each named field opened. Throws when a field is not sealed,
 * was sealed for another purpose or field, or has been altered.
 */
export function openFields<T extends Record<string, unknown>>(
  payload: Record<string, unknown>,
  fields: readonly string[],
  key: Buffer,
  purpose: string,
): T {
  const out: Record<string, unknown> = { ...payload };
  for (const field of fields) {
    const value = payload[field] as Partial<SealedField> | undefined;
    if (!value || value.sealed !== FIELD_SEAL_VERSION || !value.ciphertext || !value.iv || !value.tag) {
      throw new Error(`Field "${field}" is not a sealed value.`);
    }
    out[field] = JSON.parse(
      openSecret({ ciphertext: value.ciphertext, iv: value.iv, tag: value.tag }, key, binding(purpose, field)),
    );
  }
  return out as T;
}
