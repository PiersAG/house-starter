// lib/mfa/totp.ts — authenticator-code checks (SEC.15).
//
// Codes are generated with otplib at fixed instants, so the window and the
// replay guard are asserted against exact time steps rather than wall-clock luck.

import { describe, expect, it } from "vitest";
import { generate } from "otplib";
import {
  buildOtpauthUri,
  generateTotpSecret,
  looksLikeTotpCode,
  normalizeTotpCode,
  TOTP_PERIOD_SECONDS,
  verifyTotpCode,
} from "@/lib/mfa/totp";

const secret = generateTotpSecret();
/** A fixed instant, exactly at the start of a time step. */
const T0 = new Date(1_900_000_020 * 1000);
const STEP = Math.floor(T0.getTime() / 1000 / TOTP_PERIOD_SECONDS);

async function codeAt(offsetSteps: number): Promise<string> {
  return generate({
    secret,
    epoch: T0.getTime() / 1000 + offsetSteps * TOTP_PERIOD_SECONDS,
  });
}

describe("generateTotpSecret / buildOtpauthUri", () => {
  it("makes a 160-bit base32 secret, different every time", () => {
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it("builds a scannable otpauth URI with issuer, account and standard parameters", () => {
    const uri = buildOtpauthUri({ issuer: "Acme", accountLabel: "owner@example.com", secret });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("issuer=Acme");
    expect(uri).toContain("owner%40example.com");
    // Standard 6 digits / 30 seconds are the URI defaults, so otplib omits them;
    // anything non-standard would appear here and break some authenticator apps.
    expect(uri).not.toMatch(/digits=(?!6)|period=(?!30)|algorithm=(?!SHA1)/);
  });
});

describe("code shape", () => {
  it("accepts six digits, tolerating spaces", () => {
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
    expect(looksLikeTotpCode("123 456")).toBe(true);
    expect(looksLikeTotpCode("12345")).toBe(false);
    expect(looksLikeTotpCode("ABCD-EFGH-JKLM")).toBe(false);
  });
});

describe("verifyTotpCode", () => {
  it("accepts the current code and reports its step", async () => {
    const result = await verifyTotpCode({ secret, code: await codeAt(0), lastUsedStep: null, now: T0 });
    expect(result).toEqual({ valid: true, step: STEP });
  });

  it("accepts one step either side for clock drift", async () => {
    for (const offset of [-1, 1]) {
      const result = await verifyTotpCode({
        secret,
        code: await codeAt(offset),
        lastUsedStep: null,
        now: T0,
      });
      expect(result).toEqual({ valid: true, step: STEP + offset });
    }
  });

  it("refuses codes two steps away", async () => {
    for (const offset of [-2, 2]) {
      const result = await verifyTotpCode({
        secret,
        code: await codeAt(offset),
        lastUsedStep: null,
        now: T0,
      });
      expect(result).toEqual({ valid: false });
    }
  });

  it("refuses a wrong code and a malformed one", async () => {
    const good = await codeAt(0);
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, "0");
    expect(await verifyTotpCode({ secret, code: wrong, lastUsedStep: null, now: T0 })).toEqual({
      valid: false,
    });
    expect(await verifyTotpCode({ secret, code: "12ab56", lastUsedStep: null, now: T0 })).toEqual({
      valid: false,
    });
  });

  it("is single-use: refuses a replay of an already-used step, and anything older", async () => {
    const code = await codeAt(0);
    expect(await verifyTotpCode({ secret, code, lastUsedStep: STEP, now: T0 })).toEqual({
      valid: false,
    });
    expect(
      await verifyTotpCode({ secret, code: await codeAt(-1), lastUsedStep: STEP, now: T0 }),
    ).toEqual({ valid: false });
    // The NEXT step is still accepted after STEP was used.
    expect(
      await verifyTotpCode({ secret, code: await codeAt(1), lastUsedStep: STEP, now: T0 }),
    ).toEqual({ valid: true, step: STEP + 1 });
  });

  it("uses the real clock when no instant is given", async () => {
    const code = await generate({ secret });
    const result = await verifyTotpCode({ secret, code, lastUsedStep: null });
    expect(result.valid).toBe(true);
  });
});
