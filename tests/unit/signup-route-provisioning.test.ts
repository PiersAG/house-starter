// @vitest-environment node
// POST /api/auth/signup is all or nothing (app-business-core issue 358: "NEVER a
// half-created account, never a crash").
//
// The route is in the sign-in kernel, which the safety gate keeps Claude Code
// from writing; the CEO script applies the edit
// (app-business-core Dispatch AG, blocked/apply_signup_route.py) and sets the
// flag below to false in the same step. Until then this test pins the original
// route, so it never passes by skipping; after, it requires the new behaviour.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SIGNUP_ROUTE_EDIT_PENDING = false;

const state = vi.hoisted(() => ({
  provision: { ok: true, tenantId: "t".padEnd(33, "0") } as { ok: boolean; tenantId?: string; database?: string },
  trialThrows: false,
}));

vi.mock("@/lib/catalog", () => ({ catalogDb: {} }));
vi.mock("@/lib/csrf", () => ({ verifySameOrigin: () => null }));
vi.mock("@/lib/abuse/route-limit", () => ({ withRouteLimit: (_id: string, h: unknown) => h }));
vi.mock("@/lib/auth-rate-limit", () => ({
  AUTH_RATE_LIMITS: { signup: {}, signupProvision: {} },
  checkAuthRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/users", () => ({
  RegistrationError: class extends Error {},
  registerUser: async () => ({ id: "u1", email: "new@example.com", name: null }),
}));
vi.mock("@/lib/billing/trial", () => ({
  startTrialForNewOwner: async () => {
    if (state.trialThrows) throw new Error("planted trial failure");
  },
}));
vi.mock("@/lib/tenant/provisioner", () => ({ ensureTenantForUser: async () => "t".padEnd(33, "0") }));
vi.mock("@/lib/tenant/signup-provisioning", async (orig) => {
  const real = await orig<typeof import("@/lib/tenant/signup-provisioning")>();
  return { ...real, provisionNewAccount: async () => state.provision };
});

import { SIGNUP_PROVISION_FAILED_MESSAGE } from "@/lib/tenant/signup-provisioning";
import { POST } from "@/app/api/auth/signup/route";

const ROUTE_SRC = readFileSync(join(__dirname, "..", "..", "app/api/auth/signup/route.ts"), "utf8");

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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// Before the edit every case checks the route is still the original (so nothing
// is skipped either way); after it, each case checks the new behaviour.
function pinnedOriginal(): boolean {
  if (!SIGNUP_ROUTE_EDIT_PENDING) return false;
  expect(ROUTE_SRC).toContain("await ensureTenantForUser(user.id, { label: user.email });");
  expect(ROUTE_SRC).not.toContain("provisionNewAccount");
  return true;
}

describe("the sign-up route, all or nothing", () => {
  it("creates the account when its database is set up", async () => {
    if (pinnedOriginal()) return;
    expect((await signup()).status).toBe(201);
  });
  it("answers a clean 503 to retry — never a 500 — when the database could not be set up", async () => {
    if (pinnedOriginal()) return;
    state.provision = { ok: false, database: "removed" };
    const r = await signup();
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe("60");
    expect(await r.json()).toEqual({ error: SIGNUP_PROVISION_FAILED_MESSAGE });
  });
  it("keeps a finished account when only the trial fails, as the form does", async () => {
    if (pinnedOriginal()) return;
    state.trialThrows = true;
    expect((await signup()).status).toBe(201);
  });
  it("no longer calls ensureTenantForUser itself", () => {
    if (pinnedOriginal()) return;
    expect(ROUTE_SRC).not.toContain("ensureTenantForUser");
  });
});
