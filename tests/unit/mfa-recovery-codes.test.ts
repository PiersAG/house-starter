// lib/mfa/recovery-codes.ts — generation, hashing and shape (SEC.15).
// Single-use consumption is a database property, asserted in mfa-enrollment.test.ts.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateRecoveryCode,
  generateRecoveryCodeSet,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@/lib/mfa/recovery-codes";

describe("recovery codes", () => {
  it("formats as three groups of four from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateRecoveryCode()).toMatch(
        /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/,
      );
    }
  });

  it("issues ten distinct codes by default, each with its hash", () => {
    const { codes, hashes } = generateRecoveryCodeSet();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    expect(hashes).toEqual(codes.map(hashRecoveryCode));
    expect(generateRecoveryCodeSet(3).codes).toHaveLength(3);
  });

  it("hashes with SHA-256 over the normalised form, so typing variations match", () => {
    const code = "ABCD-EFGH-JKMN";
    const expected = createHash("sha256").update("ABCDEFGHJKMN").digest("hex");
    expect(hashRecoveryCode(code)).toBe(expected);
    expect(hashRecoveryCode("abcd efgh jkmn")).toBe(expected);
    expect(hashRecoveryCode(code)).not.toContain("ABCD");
  });

  it("recognises the shape after normalising, and nothing else", () => {
    expect(normalizeRecoveryCode(" abcd-efgh jkmn ")).toBe("ABCDEFGHJKMN");
    expect(looksLikeRecoveryCode("abcd-efgh-jkmn")).toBe(true);
    expect(looksLikeRecoveryCode("123456")).toBe(false);
    // O and I are not in the alphabet.
    expect(looksLikeRecoveryCode("OOOO-IIII-OOOO")).toBe(false);
  });
});
