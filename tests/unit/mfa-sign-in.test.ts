// lib/mfa/sign-in.ts — reading the submitted code and recognising a
// second-factor refusal after Auth.js has wrapped it (SEC.15).

import { describe, expect, it } from "vitest";
import {
  MFA_SIGN_IN_REASONS,
  MfaSignInError,
  mfaSignInReason,
  submittedCode,
} from "@/lib/mfa/sign-in";

describe("submittedCode", () => {
  it("treats Auth.js's stringified absence as no code", () => {
    expect(submittedCode("undefined")).toBe("");
    expect(submittedCode("null")).toBe("");
    expect(submittedCode(" null ")).toBe("");
  });

  it("returns a real code trimmed, and nothing for non-strings", () => {
    expect(submittedCode(" 123456 ")).toBe("123456");
    expect(submittedCode("ABCD-EFGH-JKLM")).toBe("ABCD-EFGH-JKLM");
    expect(submittedCode("")).toBe("");
    expect(submittedCode(undefined)).toBe("");
    expect(submittedCode(null)).toBe("");
    expect(submittedCode(123456)).toBe("");
  });
});

describe("mfaSignInReason", () => {
  it.each(MFA_SIGN_IN_REASONS)("recognises %s directly", (reason) => {
    const error = new MfaSignInError(reason);
    expect(error.name).toBe("MfaSignInError");
    expect(mfaSignInReason(error)).toBe(reason);
  });

  it("recognises the reason nested the way Auth.js nests it", () => {
    // CallbackRouteError -> cause { err, provider } -> the original error.
    const wrapped = new Error("CallbackRouteError", {
      cause: { err: new MfaSignInError("mfa_code_invalid"), provider: "credentials" },
    });
    expect(mfaSignInReason(wrapped)).toBe("mfa_code_invalid");
  });

  it("recognises the marker after the error has been re-created from its message", () => {
    const serialised = new Error("Read more at https://errors.authjs.dev mfa_totp_locked");
    expect(mfaSignInReason(new Error("outer", { cause: serialised }))).toBe("mfa_totp_locked");
  });

  it("is null for anything else, including a wrong password and non-errors", () => {
    expect(mfaSignInReason(new Error("CredentialsSignin"))).toBeNull();
    expect(mfaSignInReason(null)).toBeNull();
    expect(mfaSignInReason("mfa_code_required")).toBeNull();
    expect(mfaSignInReason(new Error("outer", { cause: "mfa_code_required" }))).toBeNull();
  });

  it("stops walking a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(mfaSignInReason(a)).toBeNull();
  });
});
