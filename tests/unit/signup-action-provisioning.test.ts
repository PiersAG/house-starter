// @vitest-environment node
// The sign-up FORM never crashes on provisioning (app-business-core issue 358,
// "never a crash"; Dispatch AG's independent review, finding 2): even if
// provisionNewAccount threw past its own rollback, the server action answers the
// fixed message, never a 500, and never the error's own text. Every failure —
// whatever was left behind — gets the one fixed "please try again", never "wait
// an hour" (CEO ruling 2026-11-03, Dispatch AG-fix5).

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "ok" as "ok" | "fails" | "kept" | "exists" | "unknown" | "throws",
  register: "ok" as "ok" | "throws" | "retry-lost",
  signedIn: false,
}));

vi.mock("@/lib/auth", () => ({
  signIn: vi.fn(async () => {
    state.signedIn = true;
  }),
}));
vi.mock("@/lib/catalog", () => ({ catalogDb: {} }));
vi.mock("@/lib/abuse/route-limit", () => ({ guardRouteAction: async () => false, ROUTE_LIMIT_MESSAGE: "limited" }));
vi.mock("@/lib/auth-rate-limit", () => ({
  AUTH_RATE_LIMITS: { signup: {}, signupProvision: {} },
  guardAuthAttempt: async () => ({ allowed: true }),
}));
vi.mock("@/lib/users", async () => {
  const { SIGNUP_FAILED_MESSAGE } = await import("@/lib/signup-failure");
  class SignupRetryError extends Error {
    constructor() {
      super(SIGNUP_FAILED_MESSAGE);
    }
  }
  return {
    RegistrationError: class extends Error {},
    SignupRetryError,
    registerUser: async () => {
      if (state.register === "throws") throw new Error("planted: SQLITE_ERROR no such table: users");
      if (state.register === "retry-lost") throw new SignupRetryError();
      return { id: "u1", email: "new@example.com", name: null };
    },
    ACCOUNT_EXISTS_MESSAGE: "An account with this email already exists. Try signing in instead.",
  };
});
vi.mock("@/lib/billing/trial", () => ({ startTrialForNewOwner: async () => {} }));
vi.mock("@/lib/tenant/signup-provisioning", async (orig) => {
  const real = await orig<typeof import("@/lib/tenant/signup-provisioning")>();
  return {
    ...real,
    provisionNewAccount: async () => {
      if (state.mode === "throws") throw new Error("planted: SQLITE_BUSY catalog internals");
      if (state.mode === "fails") return real.signupFailure("removed", "removed");
      if (state.mode === "kept") return real.signupFailure("kept", "listed-for-sweep");
      if (state.mode === "exists") return real.signupFailure("exists", "none");
      if (state.mode === "unknown") return real.signupFailure("unknown", "listed-for-sweep");
      return { ok: true, tenantId: "t".padEnd(33, "0") };
    },
  };
});

import { signupAction } from "@/app/signup/actions";

const FIXED = { error: "Something went wrong creating your account. Please try again." };

function form(): FormData {
  const f = new FormData();
  f.set("email", "new@example.com");
  f.set("password", "a-long-enough-password-1");
  return f;
}

beforeEach(() => {
  state.mode = "ok";
  state.register = "ok";
  state.signedIn = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the sign-up form, all or nothing", () => {
  it("signs the new account in when its database is set up", async () => {
    expect(await signupAction(null, form())).toBeNull();
    expect(state.signedIn).toBe(true);
  });
  for (const mode of ["fails", "kept", "exists", "unknown", "throws"] as const) {
    it(`a failed set-up (${mode}): the fixed 'please try again', never an hour, never the error`, async () => {
      state.mode = mode;
      const r = await signupAction(null, form());
      expect(r).toEqual(FIXED);
      expect(JSON.stringify(r)).not.toMatch(/hour|SQLITE/i);
      expect(state.signedIn).toBe(false);
    });
  }
  for (const register of ["throws", "retry-lost"] as const) {
    it(`registration fails unexpectedly (${register}): the same fixed message, never an hour`, async () => {
      state.register = register;
      const r = await signupAction(null, form());
      expect(r).toEqual(FIXED);
      expect(JSON.stringify(r)).not.toMatch(/hour|SQLITE/i);
      expect(state.signedIn).toBe(false);
    });
  }
});
