// Password hashing and policy tests (spec C4b, Deliverable C).
//
// Exercises lib/password.ts at its real behavioural seams: the hash/verify
// round-trip, rejection of wrong passwords, per-hash salt uniqueness, the
// delegation to bcrypt's timing-safe compare (never string equality), and
// fail-closed handling of malformed/missing hashes. Policy checks cover the
// NIST length floor and the embedded breached-password screen.

import { describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  isBreachedPassword,
  validatePasswordStrength,
  verifyPassword,
} from "@/lib/password";

describe("hashPassword / verifyPassword round-trip", () => {
  it("verifies the exact password that was hashed", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(
      true,
    );
  });

  it("rejects a wrong password against the same hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery stapl", hash)).resolves.toBe(
      false,
    );
    await expect(verifyPassword("", hash)).resolves.toBe(false);
  });

  it("never stores the plaintext: the hash is a bcrypt digest, not the password", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(hash).not.toContain("hunter2hunter2");
    // bcrypt modular crypt format: $2a$/$2b$/$2y$ + cost + 53 chars.
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$.{53}$/);
  });

  it("salts every hash: hashing the same password twice yields different hashes", async () => {
    const first = await hashPassword("same password every time");
    const second = await hashPassword("same password every time");
    expect(first).not.toBe(second);
    // Both must still verify — differing hashes are salt, not corruption.
    await expect(verifyPassword("same password every time", first)).resolves.toBe(true);
    await expect(verifyPassword("same password every time", second)).resolves.toBe(
      true,
    );
  });
});

describe("verifyPassword — timing-safe comparison and fail-closed handling", () => {
  it("delegates to bcrypt.compare (timing-safe), never string equality", async () => {
    const compareSpy = vi.spyOn(bcrypt, "compare");
    try {
      const hash = await hashPassword("delegation check 123");
      await verifyPassword("delegation check 123", hash);
      expect(compareSpy).toHaveBeenCalledWith("delegation check 123", hash);
    } finally {
      compareSpy.mockRestore();
    }
  });

  it("returns false (not throw) for an empty stored hash", async () => {
    await expect(verifyPassword("anything at all", "")).resolves.toBe(false);
  });

  it("returns false (not throw) for a malformed stored hash", async () => {
    await expect(
      verifyPassword("anything at all", "not-a-bcrypt-hash"),
    ).resolves.toBe(false);
  });

  it("returns false (not throw) when bcrypt itself rejects the input", async () => {
    // A non-string hash makes bcryptjs throw "Illegal arguments" — the
    // verify seam must swallow that into a clean denial, never a 500.
    await expect(
      verifyPassword("anything at all", 12345 as unknown as string),
    ).resolves.toBe(false);
  });
});

describe("validatePasswordStrength — NIST length floor", () => {
  it("rejects passwords shorter than the floor, naming the requirement", () => {
    const message = validatePasswordStrength("short");
    expect(message).toMatch(new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`));
  });

  it("rejects non-string input fail-closed (same actionable message)", () => {
    const message = validatePasswordStrength(undefined as unknown as string);
    expect(message).toMatch(/at least/);
  });

  it("accepts a strong password (returns null)", () => {
    expect(validatePasswordStrength("correct horse battery staple")).toBeNull();
  });

  it("boundary: exactly the minimum length passes the length check", () => {
    // 8 chars, not on the breach list.
    expect(validatePasswordStrength("zq4!Xv9k")).toBeNull();
  });
});

describe("validatePasswordStrength / isBreachedPassword — breach screen", () => {
  it("rejects a known breached password with the breach message", () => {
    const message = validatePasswordStrength("password123");
    expect(message).toMatch(/known data breach/);
  });

  it("screens case-insensitively", () => {
    expect(isBreachedPassword("PASSWORD123")).toBe(true);
    expect(validatePasswordStrength("PaSsWoRd123")).toMatch(/known data breach/);
  });

  it("passes a password that is not on the list", () => {
    expect(isBreachedPassword("correct horse battery staple")).toBe(false);
  });
});
