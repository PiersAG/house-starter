// Tenant-role authorization (lib/authz.ts) — the check that "signed in" is not
// the same as "allowed".
//
// The defect this module closes was a write route authorising on
// `if (!userId) 401` and nothing else. These tests are written against the PURE
// core (roleFromSession / assertTenantOwner) rather than the auth()-calling
// wrapper, because the property that matters — an absent or unrecognised role
// fails CLOSED, never open — is a property of the decision, not of the fetch.

import { describe, expect, it, vi } from "vitest";
import {
  NotAuthorizedError,
  assertTenantOwner,
  currentRole,
  requireTenantOwner,
  roleFromSession,
} from "@/lib/authz";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "owner" } })),
}));
const { auth } = await import("@/lib/auth");

describe("roleFromSession — fails closed on anything it does not recognise", () => {
  it("reads a valid role", () => {
    expect(roleFromSession({ user: { role: "owner" } })).toBe("owner");
  });

  // Each of these is a way the claim can be missing or wrong in the wild: a
  // session minted before the claim existed, an anonymous request, a downgraded
  // deploy, a hand-edited token. All resolve to null — NEVER to "owner".
  it.each([
    ["no session", null],
    ["undefined session", undefined],
    ["null user", { user: null }],
    ["no user key", {}],
    ["role absent (pre-claim session)", { user: {} }],
    ["role null", { user: { role: null } }],
    ["role empty", { user: { role: "" } }],
    ["unrecognised role", { user: { role: "superadmin" } }],
    ["role of the wrong case", { user: { role: "Owner" } }],
  ])("%s → null, not owner", (_label, session) => {
    expect(roleFromSession(session as never)).toBeNull();
  });
});

describe("assertTenantOwner", () => {
  it("returns the role for an owner", () => {
    expect(assertTenantOwner({ user: { role: "owner" } })).toBe("owner");
  });

  it("throws NotAuthorizedError for a non-owner", () => {
    expect(() => assertTenantOwner({ user: { role: "assistant" } })).toThrow(
      NotAuthorizedError,
    );
  });

  it("throws for an absent role rather than assuming ownership", () => {
    expect(() => assertTenantOwner({ user: {} })).toThrow(NotAuthorizedError);
  });

  it("carries a plain-English message, not a code", () => {
    // CEO-readable outputs rule: this string reaches a user.
    try {
      assertTenantOwner(null);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(NotAuthorizedError);
      expect((error as Error).message).toBe(
        "Only the workspace owner can change these settings.",
      );
      expect((error as Error).name).toBe("NotAuthorizedError");
    }
  });

  it("uses the default message when constructed bare", () => {
    expect(new NotAuthorizedError().message).toBe(
      "You do not have permission to do that.",
    );
  });
});

describe("the auth()-resolving wrappers", () => {
  it("currentRole reads the live session", async () => {
    expect(await currentRole()).toBe("owner");
  });

  it("requireTenantOwner passes for an owner session", async () => {
    expect(await requireTenantOwner()).toBe("owner");
  });

  it("requireTenantOwner throws when the live session has no role", async () => {
    vi.mocked(auth).mockResolvedValueOnce({ user: { id: "u1" } } as never);
    await expect(requireTenantOwner()).rejects.toBeInstanceOf(NotAuthorizedError);
  });

  it("currentRole returns null for an anonymous session", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    expect(await currentRole()).toBeNull();
  });
});
