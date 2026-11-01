// @vitest-environment node
// Forged session tokens are rejected AND logged (PiersAG/app-business-core#798,
// #440; Matt Murphy #44: "test modified, expired, wrongly-issued and unsigned
// tokens against every protected route and confirm they are rejected AND
// logged").
//
// This drives the sign-in library's REAL session handling (Auth.js `Auth()` with
// the template's own auth.config.ts) with each kind of bad cookie, so what is
// asserted is the decoder production runs, not a mock. A valid token is the
// positive control. The route-by-route sweep over every protected route with the
// same cookies is tests/isolation/anon.spec.ts; the logger itself is
// lib/session-token-log.ts.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encode } from "@auth/core/jwt";
import type { NextAuthConfig } from "next-auth";

const SECRET = "unit-test-session-secret-not-used-anywhere-real";
const COOKIE = "authjs.session-token";
let authConfig: NextAuthConfig;
let AuthFn: (req: Request, config: NextAuthConfig) => Promise<Response>;

beforeAll(async () => {
  process.env.AUTH_SECRET = SECRET;
  ({ authConfig } = await import("@/auth.config"));
  ({ Auth: AuthFn } = (await import("@auth/core")) as unknown as {
    Auth: (req: Request, config: NextAuthConfig) => Promise<Response>;
  });
});

afterEach(() => vi.restoreAllMocks());

const CLAIMS = { id: "user-1", sub: "user-1", role: "owner", tenantId: "t1" };

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

async function token(overrides: { secret?: string; maxAge?: number } = {}): Promise<string> {
  return encode({
    token: CLAIMS,
    secret: overrides.secret ?? SECRET,
    salt: COOKIE,
    maxAge: overrides.maxAge ?? 3600,
  });
}

/** Ask the library for the session this cookie carries. */
async function sessionFor(cookie: string): Promise<{ body: unknown; cleared: boolean }> {
  const res = await AuthFn(
    new Request("http://localhost:3000/api/auth/session", {
      headers: { cookie: `${COOKIE}=${cookie}` },
    }),
    { ...authConfig, basePath: "/api/auth" },
  );
  const setCookie = res.headers.get("set-cookie") ?? "";
  return {
    body: await res.json(),
    cleared: new RegExp(`${COOKIE}=;`).test(setCookie) || /Max-Age=0/i.test(setCookie),
  };
}

function rejections(): Array<Record<string, unknown>> {
  return vi
    .mocked(console.warn)
    .mock.calls.map((c) => String(c[0]))
    .filter((l) => l.startsWith('{"security_event":"session_token_rejected"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("#798 forged session tokens", () => {
  it("positive control: a valid token yields the session and logs nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { body } = await sessionFor(await token());
    expect(body).toMatchObject({ user: { id: "user-1" } });
    expect(rejections()).toEqual([]);
  });

  const forged: Array<[string, () => Promise<string>]> = [
    [
      "modified (one character of the token changed)",
      async () => {
        const t = await token();
        const i = Math.floor(t.length / 2);
        return t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
      },
    ],
    ["expired", () => token({ maxAge: -3600 })],
    ["wrongly issued (signed with another app's secret)", () => token({ secret: "another-apps-secret" })],
    [
      "unsigned (alg none)",
      async () =>
        `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
          JSON.stringify({ ...CLAIMS, exp: Math.floor(Date.now() / 1000) + 3600 }),
        )}.`,
    ],
    ["garbage", async () => "not-a-token"],
  ];

  for (const [label, make] of forged) {
    it(`a ${label} token is rejected, its cookie cleared, and the rejection logged`, async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const bad = await make();
      const { body, cleared } = await sessionFor(bad);
      expect(body).toBeNull();
      expect(cleared).toBe(true);
      const logged = rejections();
      expect(logged).toHaveLength(1);
      expect(typeof logged[0].reason).toBe("string");
      expect(logged[0].reason).not.toBe("");
      // The token itself is never written to the log.
      expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).not.toContain(bad);
    });
  }

  it("an expired token is logged with the decoder's own reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await sessionFor(await token({ maxAge: -3600 }));
    expect(rejections()[0].reason).toMatch(/expired/i);
  });
});

describe("logAuthLibraryError", () => {
  it("passes other sign-in library errors through as one plain line", async () => {
    const { logAuthLibraryError, rejectionReason } = await import("@/lib/session-token-log");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = Object.assign(new Error("bad callback"), { type: "CallbackRouteError" });
    logAuthLibraryError(e);
    expect(err).toHaveBeenCalledWith("[auth][error] CallbackRouteError: bad callback");
    expect(warn).not.toHaveBeenCalled();
    // An error with no type falls back to its name; no cause → "unknown".
    logAuthLibraryError(new TypeError("x"));
    expect(err).toHaveBeenLastCalledWith("[auth][error] TypeError: x");
    expect(rejectionReason(new Error("no cause"))).toBe("unknown");
    expect(rejectionReason(Object.assign(new Error("c"), { cause: { err: "not an error" } }))).toBe(
      "unknown",
    );
    // A throwing console never escapes.
    err.mockImplementation(() => {
      throw new Error("console down");
    });
    expect(() => logAuthLibraryError(new Error("y"))).not.toThrow();
  });
});
