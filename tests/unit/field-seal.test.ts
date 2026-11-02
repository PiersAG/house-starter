// @vitest-environment node
//
// Sealed payload fields (app-business-core issue 445; Matt Murphy #64): a
// sealed field reads as ciphertext to anyone between the two ends, opens only
// with the shared key, and cannot be moved to another field or purpose.

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { FIELD_SEAL_VERSION, openFields, sealFields } from "@/lib/crypto/field-seal";

const KEY = randomBytes(32);
const PAYLOAD = { id: "r1", email: "owner@example.com", notes: { allergy: "penicillin" }, count: 3 };

describe("lib/crypto/field-seal.ts", () => {
  it("seals only the named fields, and none of their text survives", () => {
    const sealed = sealFields(PAYLOAD, ["email", "notes"], KEY, "mobile-sync");
    expect(sealed.id).toBe("r1");
    expect(sealed.count).toBe(3);
    expect(sealed.email.sealed).toBe(FIELD_SEAL_VERSION);
    const wire = JSON.stringify(sealed);
    expect(wire).not.toContain("owner@example.com");
    expect(wire).not.toContain("penicillin");
  });

  it("opens with the same key and purpose", () => {
    const sealed = sealFields(PAYLOAD, ["email", "notes"], KEY, "mobile-sync");
    expect(openFields(sealed, ["email", "notes"], KEY, "mobile-sync")).toEqual(PAYLOAD);
  });

  it("seals a missing field as null", () => {
    const sealed = sealFields({ a: undefined as unknown }, ["a"], KEY, "p");
    expect(openFields(sealed, ["a"], KEY, "p")).toEqual({ a: null });
  });

  it("refuses another key, another purpose, a field moved, a change, or a plain value", () => {
    const sealed = sealFields(PAYLOAD, ["email", "notes"], KEY, "mobile-sync");
    expect(() => openFields(sealed, ["email"], randomBytes(32), "mobile-sync")).toThrow();
    expect(() => openFields(sealed, ["email"], KEY, "webhook")).toThrow();
    expect(() => openFields({ ...sealed, email: sealed.notes }, ["email"], KEY, "mobile-sync")).toThrow();
    const altered = { ...sealed, email: { ...sealed.email, ciphertext: Buffer.from("x").toString("base64") } };
    expect(() => openFields(altered, ["email"], KEY, "mobile-sync")).toThrow();
    expect(() => openFields(PAYLOAD, ["email"], KEY, "mobile-sync")).toThrow(/not a sealed value/);
    expect(() => openFields({}, ["email"], KEY, "mobile-sync")).toThrow(/not a sealed value/);
    expect(() => openFields({ email: { sealed: FIELD_SEAL_VERSION } }, ["email"], KEY, "p")).toThrow(/not a sealed value/);
  });
});
