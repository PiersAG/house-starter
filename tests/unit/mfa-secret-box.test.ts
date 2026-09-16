// lib/crypto/secret-box.ts — the at-rest seal for TOTP secrets (SEC.15).
//
// The properties that matter are negative ones: a wrong key, a wrong owner, or
// any altered byte must FAIL to open rather than yield a plaintext. Each is
// asserted directly.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  loadSecretBoxKey,
  MFA_KEY_ENV,
  openSecret,
  SecretBoxKeyError,
  sealSecret,
  type SealedSecret,
} from "@/lib/crypto/secret-box";

const key = randomBytes(32);

/** Flip one bit of a base64 field. */
function flip(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  bytes[0] ^= 0x01;
  return bytes.toString("base64");
}

describe("loadSecretBoxKey", () => {
  it("returns the 32-byte key from base64", () => {
    const loaded = loadSecretBoxKey({ [MFA_KEY_ENV]: key.toString("base64") });
    expect(loaded.equals(key)).toBe(true);
  });

  it("fails loudly, naming the variable, when unset or blank", () => {
    expect(() => loadSecretBoxKey({})).toThrow(SecretBoxKeyError);
    expect(() => loadSecretBoxKey({ [MFA_KEY_ENV]: "   " })).toThrow(/MFA_ENCRYPTION_KEY is not set/);
  });

  it("rejects a key of the wrong length without echoing it", () => {
    const short = randomBytes(16).toString("base64");
    let message = "";
    try {
      loadSecretBoxKey({ [MFA_KEY_ENV]: short });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/must be 32 bytes/);
    expect(message).not.toContain(short);
  });

  it("reads process.env by default", () => {
    const previous = process.env[MFA_KEY_ENV];
    process.env[MFA_KEY_ENV] = key.toString("base64");
    try {
      expect(loadSecretBoxKey().equals(key)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[MFA_KEY_ENV];
      else process.env[MFA_KEY_ENV] = previous;
    }
  });
});

describe("seal / open", () => {
  it("round-trips, and never stores the plaintext", () => {
    const sealed = sealSecret("JBSWY3DPEHPK3PXP", key, "user-1");
    expect(JSON.stringify(sealed)).not.toContain("JBSWY3DPEHPK3PXP");
    expect(openSecret(sealed, key, "user-1")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("uses a fresh IV every time — equal plaintexts give different ciphertexts", () => {
    const a = sealSecret("same", key, "user-1");
    const b = sealSecret("same", key, "user-1");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it.each<[string, (s: SealedSecret) => SealedSecret]>([
    ["ciphertext", (s) => ({ ...s, ciphertext: flip(s.ciphertext) })],
    ["iv", (s) => ({ ...s, iv: flip(s.iv) })],
    ["tag", (s) => ({ ...s, tag: flip(s.tag) })],
  ])("refuses to open when the %s has been altered", (_part, tamper) => {
    const sealed = sealSecret("secret", key, "user-1");
    expect(() => openSecret(tamper(sealed), key, "user-1")).toThrow();
  });

  it("refuses a truncated authentication tag", () => {
    const sealed = sealSecret("secret", key, "user-1");
    const truncated = Buffer.from(sealed.tag, "base64").subarray(0, 8).toString("base64");
    expect(() => openSecret({ ...sealed, tag: truncated }, key, "user-1")).toThrow(
      /invalid authentication tag/,
    );
  });

  it("refuses a different key", () => {
    const sealed = sealSecret("secret", key, "user-1");
    expect(() => openSecret(sealed, randomBytes(32), "user-1")).toThrow();
  });

  it("refuses a row transplanted to another account (associated data)", () => {
    const sealed = sealSecret("secret", key, "user-1");
    expect(() => openSecret(sealed, key, "user-2")).toThrow();
  });
});
