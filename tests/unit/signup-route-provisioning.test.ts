// @vitest-environment node
// POST /api/auth/signup is all or nothing (app-business-core issue 358: "NEVER a
// half-created account, never a crash"), and a failed sign-up never makes the
// person wait (CEO ruling 2026-11-03, Dispatch AG-fix5): every failure answers
// the one fixed "Something went wrong creating your account. Please try again."
// — never an hour, never the error's details — and a retry may come at once.
//
// The route is in the sign-in kernel, which the safety gate keeps Claude Code
// from writing; the CEO script applies each edit (app-business-core Dispatch AG,
// blocked/apply_signup_route.py, then blocked/apply_signup_route_fix5.py, which
// installs this version of the test with its edit).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignupProvisionResult } from "@/lib/tenant/signup-provisioning";

const state = vi.hoisted(() => ({
  provision: null as SignupProvisionResult | null,
  trialThrows: false,
  register: "ok" as "ok" | "throws" | "retry-lost" | "taken",
  provisionThrows: false,
}));

vi.mock("@/lib/catalog", () => ({ catalogDb: {} }));
vi.mock("@/lib/csrf", () => ({ verifySameOrigin: () => null }));
vi.mock("@/lib/abuse/route-limit", () => ({ withRouteLimit: (_id: string, h: unknown) => h }));
vi.mock("@/lib/auth-rate-limit", () => ({
  AUTH_RATE_LIMITS: { signup: {}, signupProvision: {} },
  checkAuthRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/users", async () => {
  const { SIGNUP_FAILED_MESSAGE } = await import("@/lib/signup-failure");
  class RegistrationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  class SignupRetryError extends Error {
    constructor() {
      super(SIGNUP_FAILED_MESSAGE);
    }
  }
  return {
    RegistrationError,
    SignupRetryError,
    ACCOUNT_EXISTS_MESSAGE: "An account with this email already exists. Try signing in instead.",
    registerUser: async () => {
      if (state.register === "throws") throw new Error("planted: SQLITE_ERROR no such table: users");
      if (state.register === "retry-lost") throw new SignupRetryError();
      if (state.register === "taken") {
        throw new RegistrationError("email_taken", "An account with this email already exists. Try signing in instead.");
      }
      return { id: "u1", email: "new@example.com", name: null };
    },
  };
});
vi.mock("@/lib/billing/trial", () => ({
  startTrialForNewOwner: async () => {
    if (state.trialThrows) throw new Error("planted trial failure");
  },
}));
vi.mock("@/lib/tenant/provisioner", () => ({ ensureTenantForUser: async () => "t".padEnd(33, "0") }));
vi.mock("@/lib/tenant/signup-provisioning", async (orig) => {
  const real = await orig<typeof import("@/lib/tenant/signup-provisioning")>();
  return {
    ...real,
    provisionNewAccount: async () => {
      if (state.provisionThrows) throw new Error("planted: SQLITE_BUSY catalog internals");
      return state.provision;
    },
  };
});

import { signupFailure } from "@/lib/tenant/signup-provisioning";
import { POST } from "@/app/api/auth/signup/route";

const ROUTE_SRC = readFileSync(join(__dirname, "..", "..", "app/api/auth/signup/route.ts"), "utf8");
const FIXED = "Something went wrong creating your account. Please try again.";

function signup(): Promise<Response> {
  return (POST as (r: Request) => Promise<Response>)(
    new Request("https://app.test/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "a-long-enough-password" }),
    }),
  );
}

beforeEach(() => {
  state.provision = { ok: true, tenantId: "t".padEnd(33, "0") };
  state.trialThrows = false;
  state.register = "ok";
  state.provisionThrows = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** A failed sign-up: 503, the fixed message, a retry at once, nothing about an hour or the error. */
async function expectFixed503(r: Response) {
  expect(r.status).toBe(503);
  expect(r.headers.get("Retry-After")).toBe("1");
  const text = await r.text();
  expect(JSON.parse(text)).toEqual({ error: FIXED });
  expect(text).not.toMatch(/hour|SQLITE/i);
}

describe("the sign-up route, all or nothing", () => {
  it("creates the account when its database is set up", async () => {
    expect((await signup()).status).toBe(201);
  });
  for (const account of ["removed", "kept", "exists", "unknown"] as const) {
    for (const database of ["none", "removed", "listed-for-sweep"] as const) {
      it(`a failed set-up (account ${account}, database ${database}): the fixed 'please try again', Retry-After 1`, async () => {
        state.provision = signupFailure(account, database);
        await expectFixed503(await signup());
      });
    }
  }
  it("keeps a finished account when only the trial fails, as the form does", async () => {
    state.trialThrows = true;
    expect((await signup()).status).toBe(201);
  });
  it("a switched-on or closed account holds the address: 409, told to sign in, as before", async () => {
    state.register = "taken";
    const r = await signup();
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "An account with this email already exists. Try signing in instead." });
  });
  it("no longer calls ensureTenantForUser itself", () => {
    expect(ROUTE_SRC).not.toContain("ensureTenantForUser");
  });
});

describe("the sign-up route never crashes, and an unexpected error gets the same fixed answer", () => {
  it("registration fails unexpectedly: the fixed 503, not a 500 or the error's text", async () => {
    state.register = "throws";
    await expectFixed503(await signup());
  });
  it("a retry that lost to another retry at the same moment: the fixed 503", async () => {
    state.register = "retry-lost";
    await expectFixed503(await signup());
  });
  it("provisioning threw past its own rollback: the same", async () => {
    state.provisionThrows = true;
    await expectFixed503(await signup());
  });
  it("no longer rethrows from its outer catch", () => {
    expect(ROUTE_SRC).not.toMatch(/\n {4}throw error;\n/);
  });
  it("never answers with a message of its own about waiting", () => {
    expect(ROUTE_SRC).not.toMatch(/in an hour|in a minute|SIGNUP_UNSURE|provisioned\.message/);
  });
});
