// @vitest-environment node
// Every branch of the session decision modules (the per-file 100% security
// coverage gate in vitest.config.ts; app-business-core issues 506, 519, 525, 741).
// The behaviour is described in session-records, session-policy and
// session-access-guard tests; this file walks the defaults and the edges: no test
// dependencies (the real request context, reputation, mailer and settings), a
// missing session id, another account's session, the strict policy's fixed life,
// and checks that cannot run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import type { JWT } from "next-auth/jwt";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { registerUser, type AppDatabase } from "@/lib/users";
import { handleTokenRenewal, recordSignOut, isSessionRevoked } from "@/lib/revoked-sessions";
import { endSessionRecord, getSessionRecord, startSessionRecord, touchSessionRecord } from "@/lib/session/records";
import { checkSessionRecord, onSessionStart, TOUCH_EVERY_MS } from "@/lib/session/hooks";
import { checkSensitiveAccess } from "@/lib/session/guard";
import { EMPTY_CONTEXT } from "@/lib/session/context";
import { safeReturnPath } from "@/lib/session/return-path";

const req = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  device: "device-aaaaaaaaaaaaaaaa" as string | null,
  headersThrow: false,
}));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (req.headersThrow) throw new Error("outside a request");
    return new Headers(req.headers);
  },
  cookies: async () => ({
    get: (name: string) => (name === "hs_device" && req.device ? { name, value: req.device } : undefined),
    getAll: () => [],
    set: () => {},
  }),
}));

let client: Client;
let db: AppDatabase;
let userId: string;
const GB = { "x-vercel-ip-country": "GB", "x-vercel-ip-latitude": "51.5", "x-vercel-ip-longitude": "-0.12" };
const FR = { "x-vercel-ip-country": "FR", "x-vercel-ip-latitude": "48.86", "x-vercel-ip-longitude": "2.35" };
const tok = (sessionId: string | undefined, over: Partial<JWT> = {}): JWT =>
  ({ id: userId, sessionId, renewAfter: 0, authTime: Math.floor(Date.now() / 1000), ...over }) as JWT;

beforeEach(async () => {
  client = createMigrationDatabase(":memory:");
  await runMigrations(client);
  db = drizzle(client) as AppDatabase;
  userId = (await registerUser(db, { email: "owner@example.com", password: "correct horse battery staple" })).id;
  req.headers = { ...GB, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537" };
  req.device = "device-aaaaaaaaaaaaaaaa";
  req.headersThrow = false;
  process.env.AUTH_SECRET ??= "unit-test-secret";
  process.env.APP_CANONICAL_URL = "https://app.example";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  client.close();
  vi.restoreAllMocks();
  delete process.env.APP_CANONICAL_URL;
});

describe("onSessionStart with the real defaults", () => {
  it("records a first sign-in from the request itself, then alerts a new device in a new country", async () => {
    await onSessionStart(db, tok("s1-aaaaaaaaaaaa"));
    expect((await getSessionRecord(db, "s1-aaaaaaaaaaaa"))?.country).toBe("GB");
    req.headers = { ...FR };
    req.device = "device-bbbbbbbbbbbbbbbb";
    await onSessionStart(db, tok("s2-aaaaaaaaaaaa", { email: "owner@example.com" }));
    const lines = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"sign_in_unfamiliar"'))).toBe(true);
  });

  it("an unfamiliar sign-in with no email address and no browser name sends nothing and does not throw", async () => {
    const sendEmail = vi.fn(async () => true);
    await onSessionStart(db, tok("s1-aaaaaaaaaaaa"), { context: async () => ({ ...EMPTY_CONTEXT, deviceId: "d-aaaaaaaaaaaaaaaaaa", country: "GB" }) });
    await onSessionStart(db, tok("s2-aaaaaaaaaaaa", { email: undefined }), {
      sendEmail,
      context: async () => ({ ...EMPTY_CONTEXT, deviceId: "d-bbbbbbbbbbbbbbbbbb", country: "FR" }),
    });
    expect(sendEmail).not.toHaveBeenCalled();
    await onSessionStart(db, tok("s3-aaaaaaaaaaaa", { email: "owner@example.com" }), {
      sendEmail,
      baseUrl: () => "https://app.example",
      appName: async () => "App",
      context: async () => ({ ...EMPTY_CONTEXT, deviceId: "d-cccccccccccccccccc", country: "ES" }),
    });
    expect((sendEmail.mock.calls[0] as unknown as [string, { device: string }])[1].device).toBe("an unknown browser");
  });

  it("a token with no session id or no account is ignored; a failure is logged, never thrown", async () => {
    await expect(onSessionStart(db, tok(undefined))).resolves.toBeUndefined();
    await expect(onSessionStart(db, { sessionId: "x-aaaaaaaaaaaa" } as JWT)).resolves.toBeUndefined();
    await expect(
      onSessionStart(db, tok("s9-aaaaaaaaaaaa"), { context: async () => { throw new Error("no request"); } }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("an account id carried as `sub` is read too", async () => {
    await onSessionStart(db, { sub: userId, sessionId: "sub-aaaaaaaaaaa" } as JWT);
    expect((await getSessionRecord(db, "sub-aaaaaaaaaaa"))?.userId).toBe(userId);
  });
});

describe("checkSessionRecord edges", () => {
  it("no session id or no account: refused", async () => {
    expect(await checkSessionRecord(db, tok(undefined), 1)).toBe("end");
    expect(await checkSessionRecord(db, { sessionId: "x-aaaaaaaaaaaa" } as JWT, 1)).toBe("end");
  });

  it("another account's session id: refused", async () => {
    const other = (await registerUser(db, { email: "b@example.com", password: "correct horse battery staple" })).id;
    await startSessionRecord(db, { sessionId: "theirs-aaaaaaaa", userId: other, context: EMPTY_CONTEXT });
    expect(await checkSessionRecord(db, tok("theirs-aaaaaaaa"), 1, { context: async () => EMPTY_CONTEXT })).toBe("end");
  });

  it("the strict policy's fixed life ends the session; under today's ruling it does not (both states)", async () => {
    const t0 = 1_800_000_000;
    await startSessionRecord(db, { sessionId: "old-aaaaaaaaaaa", userId, context: EMPTY_CONTEXT, now: new Date(t0 * 1000) });
    const later = t0 + 9 * 3600;
    const deps = { context: async () => EMPTY_CONTEXT, reputation: async () => "good" as const };
    expect(await checkSessionRecord(db, tok("old-aaaaaaaaaaa", { authTime: t0 }), later, { ...deps, policy: "renewal" })).toBe("ok");
    expect(await checkSessionRecord(db, tok("old-aaaaaaaaaaa", { authTime: t0 }), later, { ...deps, policy: "strict" })).toBe("end");
    expect((await getSessionRecord(db, "old-aaaaaaaaaaa"))?.endReason).toBe("expired");
  });

  it("with the real defaults: the request's own context and reputation are read", async () => {
    await startSessionRecord(db, { sessionId: "dflt-aaaaaaaaaa", userId, context: EMPTY_CONTEXT });
    expect(["ok", "end"]).toContain(await checkSessionRecord(db, tok("dflt-aaaaaaaaaa"), Math.floor(Date.now() / 1000)));
  });

  it("a reputation that cannot be read counts as suspect", async () => {
    await startSessionRecord(db, { sessionId: "rep-aaaaaaaaaaa", userId, context: EMPTY_CONTEXT });
    req.headersThrow = true;
    expect(
      await checkSessionRecord(db, tok("rep-aaaaaaaaaaa"), Math.floor(Date.now() / 1000), {
        context: async () => EMPTY_CONTEXT,
        contextAccess: true,
      }),
    ).toBe("ok");
    expect((await getSessionRecord(db, "rep-aaaaaaaaaaa"))?.riskScore).toBe(50);
  });

  it("writes 'last seen' at most once a minute while nothing changes, and at once when the country does", async () => {
    const t0 = Date.parse("2026-11-02T09:00:00Z");
    const gb = { ...EMPTY_CONTEXT, country: "GB", deviceId: "d-aaaaaaaaaaaaaaaaaa" };
    await startSessionRecord(db, { sessionId: "seen-aaaaaaaaaa", userId, context: gb, now: new Date(t0) });
    const deps = { reputation: async () => "good" as const, riskChecks: false, contextAccess: true };
    await checkSessionRecord(db, tok("seen-aaaaaaaaaa"), (t0 + 10_000) / 1000, { ...deps, context: async () => gb });
    expect((await getSessionRecord(db, "seen-aaaaaaaaaa"))?.lastSeenAt.getTime()).toBe(t0);
    await checkSessionRecord(db, tok("seen-aaaaaaaaaa"), (t0 + TOUCH_EVERY_MS) / 1000, { ...deps, context: async () => gb });
    expect((await getSessionRecord(db, "seen-aaaaaaaaaa"))?.lastSeenAt.getTime()).toBe(t0 + TOUCH_EVERY_MS);
    // a new country mid-session (the same device): written, and scored
    await checkSessionRecord(db, tok("seen-aaaaaaaaaa"), (t0 + TOUCH_EVERY_MS + 1000) / 1000, {
      ...deps,
      context: async () => ({ ...gb, country: "FR" }),
    });
    const r = await getSessionRecord(db, "seen-aaaaaaaaaa");
    expect([r?.country, r?.riskScore]).toEqual(["FR", 30]);
    // another device presenting the session raises the score again; back to calm resets it
    await checkSessionRecord(db, tok("seen-aaaaaaaaaa"), (t0 + TOUCH_EVERY_MS + 2000) / 1000, {
      ...deps,
      context: async () => ({ ...gb, country: "FR", deviceId: "d-zzzzzzzzzzzzzzzzzz" }),
    });
    expect((await getSessionRecord(db, "seen-aaaaaaaaaa"))?.riskScore).toBe(60);
    await checkSessionRecord(db, tok("seen-aaaaaaaaaa"), (t0 + TOUCH_EVERY_MS + 3000) / 1000, {
      ...deps,
      context: async () => ({ ...gb, country: "FR" }),
    });
    expect((await getSessionRecord(db, "seen-aaaaaaaaaa"))?.riskScore).toBe(0);
  });
});

describe("records edges", () => {
  it("ending a session twice and with the default time is harmless; touch keeps what it was not told", async () => {
    await startSessionRecord(db, { sessionId: "e-aaaaaaaaaaaaa", userId, context: { ...EMPTY_CONTEXT, country: "GB", latitude: 1, longitude: 2 } });
    expect(await endSessionRecord(db, { userId, sessionId: "e-aaaaaaaaaaaaa", reason: "ended_by_user" })).toBe(true);
    expect(await endSessionRecord(db, { userId, sessionId: "e-aaaaaaaaaaaaa", reason: "ended_by_user" })).toBe(true);
    expect(await endSessionRecord(db, { userId, sessionId: "missing-aaaaaaa", reason: "ended_by_user" })).toBe(false);
    await touchSessionRecord(db, "e-aaaaaaaaaaaaa", { context: EMPTY_CONTEXT, riskScore: 0, now: new Date() });
    const r = await getSessionRecord(db, "e-aaaaaaaaaaaaa");
    expect([r?.country, r?.latitude, r?.longitude]).toEqual(["GB", 1, 2]);
  });

  it("a cap of zero still keeps the session being started", async () => {
    await startSessionRecord(db, { sessionId: "z1-aaaaaaaaaaaa", userId, context: EMPTY_CONTEXT });
    const r = await startSessionRecord(db, { sessionId: "z2-aaaaaaaaaaaa", userId, context: EMPTY_CONTEXT, maxSessions: 0 });
    expect(r.evicted).toEqual(["z1-aaaaaaaaaaaa"]);
  });
});

describe("the renewal kernel helpers", () => {
  it("a session check that says 'end' refuses the renewal", async () => {
    expect(await handleTokenRenewal(tok("k-aaaaaaaaaaaaa"), async () => false, 10, undefined, undefined, async () => "end")).toBeNull();
  });

  it("sign-out still revokes when the device list cannot be updated", async () => {
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === "update") return () => { throw new Error("read-only"); };
        return Reflect.get(target, prop);
      },
    }) as AppDatabase;
    await recordSignOut(broken, { token: tok("so-aaaaaaaaaaaa") });
    expect(await isSessionRevoked(db, "so-aaaaaaaaaaaa")).toBe(true);
  });
});

describe("the access guard's defaults and failure", () => {
  it("reads the request's own context, reputation and clock when given none", async () => {
    await startSessionRecord(db, { sessionId: "g-aaaaaaaaaaaaa", userId, context: { ...EMPTY_CONTEXT, deviceId: "device-aaaaaaaaaaaaaaaa" } });
    const d = await checkSensitiveAccess(db, { user: { id: userId, sessionId: "g-aaaaaaaaaaaaa" } }, "account.sign-out-everywhere", "/account/security");
    expect(["allow", "step_up", "deny"]).toContain(d.decision);
  });

  it("a known device found by the account's history, a deny is logged as a denial", async () => {
    await startSessionRecord(db, { sessionId: "h-aaaaaaaaaaaaa", userId, context: { ...EMPTY_CONTEXT, deviceId: "device-aaaaaaaaaaaaaaaa" } });
    const allow = await checkSensitiveAccess(db, { user: { id: userId } }, "billing.portal", "/dashboard", {
      context: async () => ({ ...EMPTY_CONTEXT, deviceId: "device-aaaaaaaaaaaaaaaa", timezone: "Europe/London" }),
      reputation: async () => "good",
      now: () => Date.parse("2026-11-02T03:00:00Z"),
      enabled: true,
    });
    expect(allow.decision).toBe("allow");
    const deny = await checkSensitiveAccess(db, { user: { id: userId } }, "billing.portal", "/dashboard", {
      context: async () => EMPTY_CONTEXT,
      reputation: async () => "bad",
      enabled: true,
    });
    expect(deny.decision).toBe("deny");
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('"access_denied"'))).toBe(true);
  });

  it("a policy that cannot be evaluated asks for a fresh sign-in", async () => {
    const d = await checkSensitiveAccess(db, { user: { id: userId } }, "billing.portal", "/dashboard", {
      context: async () => { throw new Error("no request"); },
    });
    expect(d).toMatchObject({ decision: "step_up", reasons: ["policy_error"] });
  });
});

describe("return path edge", () => {
  it("a malformed escape falls back to the dashboard", () => {
    expect(safeReturnPath("/%E0%A4%A")).toBe("/dashboard");
  });
});

describe("the guard's messages", () => {
  it("none when allowed, a refusal when denied, a sign-in-again when stepped up", async () => {
    const { accessMessage, DENIED_MESSAGE, STEP_UP_MESSAGE } = await import("@/lib/session/guard");
    expect(accessMessage({ decision: "allow", reasons: [], loginPath: "/login" })).toBeNull();
    expect(accessMessage({ decision: "deny", reasons: [], loginPath: "/login" })).toBe(DENIED_MESSAGE);
    expect(accessMessage({ decision: "step_up", reasons: [], loginPath: "/login" })).toBe(STEP_UP_MESSAGE);
  });
});
