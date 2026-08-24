// Settings write-API enforcement (capability-model-spec R2). Invokes the REAL
// PUT/DELETE handlers of app/api/settings/[key]/route.ts to prove the capability
// guard is actually wired in — a write to a key whose capability is OFF is 404'd
// before auth, before validation, before any DB touch.
//
// Auth, the tenant handle and the value store are mocked so the handler runs
// without a live session or database: the 404 path returns before any is used,
// and the allowed path only needs the (pure) validator plus a no-op writer. The
// test is FLAG-AWARE, so it passes in every leg of the CI both-states matrix.
//
// The session carries `role: "owner"` because owner-scope writes now require it
// (lib/authz.ts) — see the explicit non-owner leg at the bottom, which is the
// assertion that this is a real check and not scenery.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { enabledCapabilities } from "@/config/capabilities";

// Authenticated owner for every call — so a 404 can only come from the
// capability guard, never from a missing session.
const session = vi.hoisted(() => ({
  auth: vi.fn(async (): Promise<unknown> => ({
    user: { id: "owner-1", tenantId: "tenant-1", role: "owner" },
  })),
}));
vi.mock("@/lib/auth", () => session);

// The handler now writes the TENANT database (finding 1), so it resolves a
// tenant handle. Mocked to a sentinel: what matters here is that the writer is
// called, and tests/unit/settings-planes.test.ts proves WHICH database receives
// it against three real ones.
vi.mock("@/lib/tenant-context", () => ({
  getTenantDb: vi.fn(async () => ({}) as never),
}));

// No-op the value store: the allowed path must not need a real database.
// vi.hoisted so the fns exist when the hoisted vi.mock factory runs.
const store = vi.hoisted(() => ({
  setOwnerValue: vi.fn(async () => {}),
  setClientValue: vi.fn(async () => {}),
  deleteValue: vi.fn(async () => true),
}));
vi.mock("@/lib/settings/values", () => store);
const { setOwnerValue, deleteValue } = store;

import { PUT, DELETE } from "@/app/api/settings/[key]/route";

function putReq(key: string, value: unknown): [Request, { params: Promise<{ key: string }> }] {
  return [
    new Request(`http://localhost/api/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ key }) },
  ];
}

function delReq(key: string): [Request, { params: Promise<{ key: string }> }] {
  return [
    new Request(`http://localhost/api/settings/${key}`, { method: "DELETE" }),
    { params: Promise.resolve({ key }) },
  ];
}

beforeEach(() => {
  setOwnerValue.mockClear();
  store.setClientValue.mockClear();
  deleteValue.mockClear();
});

describe("PUT /api/settings/[key] — capability guard (R2)", () => {
  const paymentsOn = enabledCapabilities.payments === true;

  it(`billing.currency (payments ${paymentsOn ? "ON" : "OFF"})`, async () => {
    const res = await PUT(...putReq("billing.currency", "GBP"));
    if (paymentsOn) {
      expect(res.status).toBe(200);
      expect(setOwnerValue).toHaveBeenCalledOnce();
    } else {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found." });
      // Never reached the writer.
      expect(setOwnerValue).not.toHaveBeenCalled();
    }
  });

  it("core.client_self_registration is always writable (no capability flag)", async () => {
    // A CORE key with no flag AND no operator claim — the per-tenant case. It
    // used to be core.app_name here; that key is an operator control now (one
    // app, one brand, read on anonymous requests where there is no tenant), so
    // it belongs in the refusal test below rather than this one.
    const res = await PUT(...putReq("core.client_self_registration", true));
    expect(res.status).toBe(200);
    expect(setOwnerValue).toHaveBeenCalledOnce();
  });

  it("an OPERATOR key is refused 422 and never reaches the writer", async () => {
    // The API-layer half of finding 1: a hand-rolled PUT that never went near
    // the settings page still cannot write a control-plane value. 422 (not 404)
    // because the key exists and the capability is on — the caller is simply
    // not the party who sets it.
    for (const key of ["core.app_name", "billing.trial_period_days"]) {
      const res = await PUT(...putReq(key, key === "core.app_name" ? "Pwned" : 3650));
      expect(res.status, `${key} was not refused`).toBe(422);
    }
    expect(setOwnerValue).not.toHaveBeenCalled();
  });

  it("billing.subscription_grace_days is kernel (subscription_billing) — never 404s on the guard", async () => {
    // operatorOnly → the write is rejected 422 by validation, but it must get
    // PAST the capability guard (kernel flag is always on), i.e. NOT 404.
    const res = await PUT(...putReq("billing.subscription_grace_days", 5));
    expect(res.status).not.toBe(404);
  });

  it("a caller who is NOT the tenant owner is refused 403 and never reaches the writer", async () => {
    // Proves the role check is load-bearing. Today one account = one tenant so
    // every real caller is an owner and this leg is the only thing exercising
    // the refusal — which is exactly why it is written now, rather than being
    // discovered missing when sub-users arrive.
    session.auth.mockResolvedValueOnce({
      user: { id: "assistant-1", tenantId: "tenant-1", role: "assistant" },
    });
    const res = await PUT(...putReq("core.client_self_registration", true));
    expect(res.status).toBe(403);
    expect(setOwnerValue).not.toHaveBeenCalled();
  });

  it("a session minted BEFORE the role claim existed is refused, not assumed to be the owner", async () => {
    // Fail-closed direction: absent role → re-authenticate, never "assume the
    // most privileged value".
    session.auth.mockResolvedValueOnce({
      user: { id: "owner-1", tenantId: "tenant-1" },
    });
    const res = await PUT(...putReq("core.client_self_registration", true));
    expect(res.status).toBe(403);
    expect(setOwnerValue).not.toHaveBeenCalled();
  });

  it("an unknown key is 404 from validation, not the guard (guard passes it through)", async () => {
    const res = await PUT(...putReq("nope.not_real", 1));
    expect(res.status).toBe(404);
    // Distinct body from the guard's "Not found." — proves it fell through to
    // the unknown-key validator rather than being stopped by the guard.
    expect(await res.json()).not.toEqual({ error: "Not found." });
  });
});

describe("DELETE /api/settings/[key] — capability guard (R2)", () => {
  const paymentsOn = enabledCapabilities.payments === true;

  it(`billing.currency (payments ${paymentsOn ? "ON" : "OFF"})`, async () => {
    const res = await DELETE(...delReq("billing.currency"));
    if (paymentsOn) {
      expect(res.status).toBe(200);
      expect(deleteValue).toHaveBeenCalledOnce();
    } else {
      expect(res.status).toBe(404);
      expect(deleteValue).not.toHaveBeenCalled();
    }
  });
});
