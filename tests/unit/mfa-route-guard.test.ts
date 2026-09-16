// lib/mfa/route-guard.ts — the one gate in front of every /api/auth/mfa/* route
// (SEC.15, Slice 1), tested on its own so its per-file 100% gate does not depend
// on the routes that use it. Order matters and is asserted: session, then rate
// limit (per client AND per account), then input.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resetRateLimiterForTests } from "@/lib/rate-limit";
import type { AuthRateLimit } from "@/lib/auth-rate-limit";
import { guardMfaRequest, NO_STORE } from "@/lib/mfa/route-guard";

const LIMIT: AuthRateLimit = { bucket: "mfa-guard-test", limit: 2, windowSeconds: 60 };
const schema = z.object({ code: z.string({ required_error: "Enter a code." }) });
const SESSION = { user: { id: "user-1", email: "owner@example.com" } };

function request(body: string, ip = "192.0.2.1"): Request {
  return new Request("http://localhost/api/auth/mfa/test", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body,
  });
}

beforeEach(() => {
  process.env.RATE_LIMIT_ALLOW_IN_MEMORY = "true";
  delete process.env.VERCEL_ENV;
  resetRateLimiterForTests();
});

afterEach(() => {
  delete process.env.RATE_LIMIT_ALLOW_IN_MEMORY;
  resetRateLimiterForTests();
});

describe("guardMfaRequest", () => {
  it.each([null, {}, { user: {} }, { user: { id: "" } }])(
    "401 without a signed-in account (%j), before spending any rate-limit budget",
    async (session) => {
      const result = await guardMfaRequest({
        request: request('{"code":"1"}'),
        session,
        limit: LIMIT,
        schema,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("Cache-Control")).toBe(NO_STORE["Cache-Control"]);
      // Budget untouched: two real calls still pass.
      for (let i = 0; i < LIMIT.limit; i += 1) {
        const ok = await guardMfaRequest({
          request: request('{"code":"1"}'),
          session: SESSION,
          limit: LIMIT,
          schema,
        });
        expect(ok.ok).toBe(true);
      }
    },
  );

  it("429 per client, with Retry-After", async () => {
    let last;
    for (let i = 0; i <= LIMIT.limit; i += 1) {
      last = await guardMfaRequest({
        request: request('{"code":"1"}', "192.0.2.9"),
        session: { user: { id: `user-${i}` } },
        limit: LIMIT,
        schema,
      });
    }
    expect(last!.ok).toBe(false);
    if (last!.ok) return;
    expect(last!.response.status).toBe(429);
    expect(Number(last!.response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(last!.response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("429 per account, from rotating addresses", async () => {
    let last;
    for (let i = 0; i <= LIMIT.limit; i += 1) {
      last = await guardMfaRequest({
        request: request('{"code":"1"}', `192.0.2.${100 + i}`),
        session: SESSION,
        limit: LIMIT,
        schema,
      });
    }
    expect(last!.ok).toBe(false);
    if (last!.ok) return;
    expect(last!.response.status).toBe(429);
  });

  it("400 on a body that is not JSON", async () => {
    const result = await guardMfaRequest({
      request: request("{not json"),
      session: SESSION,
      limit: LIMIT,
      schema,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: "Request body must be valid JSON." });
  });

  it("400 with the schema's first message on invalid input", async () => {
    const result = await guardMfaRequest({
      request: request("{}"),
      session: SESSION,
      limit: LIMIT,
      schema,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(await result.response.json()).toEqual({ error: "Enter a code." });
  });

  it("passes the account from the SESSION and the parsed input", async () => {
    const result = await guardMfaRequest({
      request: request('{"code":"42","userId":"someone-else"}'),
      session: SESSION,
      limit: LIMIT,
      schema,
    });
    expect(result).toEqual({
      ok: true,
      userId: "user-1",
      email: "owner@example.com",
      data: { code: "42" },
    });
  });

  it("email is null when the session carries none", async () => {
    const result = await guardMfaRequest({
      request: request('{"code":"42"}'),
      session: { user: { id: "user-2" } },
      limit: LIMIT,
      schema,
    });
    expect(result.ok && result.email).toBeNull();
  });
});
