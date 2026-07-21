// Settings write-API enforcement (capability-model-spec R2). Invokes the REAL
// PUT/DELETE handlers of app/api/settings/[key]/route.ts to prove the capability
// guard is actually wired in — a write to a key whose capability is OFF is 404'd
// before auth, before validation, before any DB touch.
//
// Auth and the value store are mocked so the handler runs without a live session
// or database: the 404 path returns before either is used, and the allowed path
// only needs the (pure) validator plus a no-op writer. The test is FLAG-AWARE,
// so it passes in every leg of the CI both-states matrix.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { enabledCapabilities } from "@/config/capabilities";

// Authenticated owner for every call — so a 404 can only come from the
// capability guard, never from a missing session.
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "owner-1" } })),
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

  it("core.app_name is always writable (no capability flag)", async () => {
    const res = await PUT(...putReq("core.app_name", "My App"));
    expect(res.status).toBe(200);
    expect(setOwnerValue).toHaveBeenCalledOnce();
  });

  it("billing.subscription_grace_days is kernel (subscription_billing) — never 404s on the guard", async () => {
    // ownerEditable:false → the write is rejected 422 by validation, but it must
    // get PAST the capability guard (kernel flag is always on), i.e. NOT 404.
    const res = await PUT(...putReq("billing.subscription_grace_days", 5));
    expect(res.status).not.toBe(404);
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
