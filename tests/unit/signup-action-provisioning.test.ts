// @vitest-environment node
// The sign-up FORM never crashes on provisioning (app-business-core issue 358,
// "never a crash"; Dispatch AG's independent review, finding 2): even if
// provisionNewAccount threw past its own rollback, the server action answers the
// fixed message, never a 500, and never the error's own text. And the message
// is true for what was left (Dispatch AG-fix4, review 4 defect B): an account
// kept switched off is told it is still being set up, never "nothing was saved".

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "ok" as "ok" | "fails" | "kept" | "throws", signedIn: false }));

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
vi.mock("@/lib/users", () => ({
  RegistrationError: class extends Error {},
  registerUser: async () => ({ id: "u1", email: "new@example.com", name: null }),
  PENDING_SIGNUP_RETRY_SECONDS: 3600,
  ACCOUNT_EXISTS_MESSAGE: "An account with this email already exists. Try signing in instead.",
}));
vi.mock("@/lib/billing/trial", () => ({ startTrialForNewOwner: async () => {} }));
vi.mock("@/lib/tenant/signup-provisioning", async (orig) => {
  const real = await orig<typeof import("@/lib/tenant/signup-provisioning")>();
  return {
    ...real,
    provisionNewAccount: async () => {
      if (state.mode === "throws") throw new Error("planted: SQLITE_BUSY catalog internals");
      if (state.mode === "fails") return real.signupFailure("removed", "removed");
      if (state.mode === "kept") return real.signupFailure("kept", "listed-for-sweep");
      return { ok: true, tenantId: "t".padEnd(33, "0") };
    },
  };
});

import {
  SIGNUP_PROVISION_FAILED_MESSAGE,
  SIGNUP_STILL_BEING_SET_UP_MESSAGE,
  SIGNUP_UNSURE_MESSAGE,
} from "@/lib/tenant/signup-provisioning";
import { signupAction } from "@/app/signup/actions";

function form(): FormData {
  const f = new FormData();
  f.set("email", "new@example.com");
  f.set("password", "a-long-enough-password-1");
  return f;
}

beforeEach(() => {
  state.mode = "ok";
  state.signedIn = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the sign-up form, all or nothing", () => {
  it("signs the new account in when its database is set up", async () => {
    expect(await signupAction(null, form())).toBeNull();
    expect(state.signedIn).toBe(true);
  });
  it("the account was removed: 'nothing was saved, try again in a minute'", async () => {
    state.mode = "fails";
    expect(await signupAction(null, form())).toEqual({ error: SIGNUP_PROVISION_FAILED_MESSAGE });
    expect(state.signedIn).toBe(false);
  });
  it("the account was kept switched off: 'still being set up, try again in an hour', never 'nothing was saved'", async () => {
    state.mode = "kept";
    const r = await signupAction(null, form());
    expect(r).toEqual({ error: SIGNUP_STILL_BEING_SET_UP_MESSAGE });
    expect(r?.error).not.toContain("nothing was saved");
    expect(state.signedIn).toBe(false);
  });
  it("shows a fixed, true message, not the error, when provisioning throws", async () => {
    state.mode = "throws";
    const r = await signupAction(null, form());
    expect(r).toEqual({ error: SIGNUP_UNSURE_MESSAGE });
    expect(JSON.stringify(r)).not.toContain("SQLITE");
    expect(state.signedIn).toBe(false);
  });
});
