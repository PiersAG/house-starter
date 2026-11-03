// @vitest-environment node
// The access policy at sensitive actions, the email sign-out link and the
// two-step requirement for owner-grant accounts (app-business-core issues 741,
// 519, 377).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { registerUser, type AppDatabase } from "@/lib/users";
import { startSessionRecord, getSessionRecord } from "@/lib/session/records";
import { checkSensitiveAccess, accessMessage, STEP_UP_MESSAGE } from "@/lib/session/guard";
import { EMPTY_CONTEXT, contextFromHeaders, deviceLabelFromUserAgent } from "@/lib/session/context";
import { newSignInTemplate, revokeToken, revokeTokenSessionId, verifyRevokeToken } from "@/lib/session/notify";
import { isSessionRevoked } from "@/lib/revoked-sessions";
import { assertTenantOwner, NotAuthorizedError } from "@/lib/authz";
import { mustEnrollTwoStep } from "@/lib/mfa/enforce";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/catalog", () => ({
  get catalogDb() {
    return holder.db;
  },
  getCatalogDb: () => holder.db,
}));
// lib/authz imports the sign-in kernel; nothing here signs in.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));

let client: Client;
let db: AppDatabase;
let userId: string;
const SECRET = "test-secret-for-links";

beforeEach(async () => {
  client = createMigrationDatabase(":memory:");
  await runMigrations(client);
  db = drizzle(client) as AppDatabase;
  holder.db = db;
  userId = (await registerUser(db, { email: "owner@example.com", password: "correct horse battery staple" })).id;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.AUTH_SECRET = SECRET;
});
afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});

describe("#741 sensitive actions ask the policy", () => {
  const T0 = Date.parse("2026-11-02T03:00:00Z"); // 3 a.m. in London
  const night = { ...EMPTY_CONTEXT, deviceId: "device-unknownnnnnnnnn", timezone: "Europe/London" };

  it("financial records at 3 a.m. from an unrecognised device are stepped up, with a sign-in path back", async () => {
    await startSessionRecord(db, {
      sessionId: "s-aaaaaaaaaaaaaa",
      userId,
      context: { ...EMPTY_CONTEXT, deviceId: "device-homeeeeeeeeeeee" },
      now: new Date(T0 - 3 * 3_600_000),
    });
    const d = await checkSensitiveAccess(db, { user: { id: userId, sessionId: "s-aaaaaaaaaaaaaa" } }, "billing.portal", "/dashboard", {
      context: async () => night,
      reputation: async () => "good",
      now: () => T0,
      enabled: true,
    });
    expect(d.decision).toBe("step_up");
    expect(d.loginPath).toBe("/login?callbackUrl=%2Fdashboard");
    expect(accessMessage(d)).toBe(STEP_UP_MESSAGE);
  });

  it("the same request from the device the account knows is allowed; with the policy OFF, everything is (both states)", async () => {
    await startSessionRecord(db, { sessionId: "s-bbbbbbbbbbbbbb", userId, context: { ...EMPTY_CONTEXT, deviceId: "device-homeeeeeeeeeeee" }, now: new Date(T0 - 3_600_000) });
    const known = { ...night, deviceId: "device-homeeeeeeeeeeee" };
    const session = { user: { id: userId, sessionId: "s-bbbbbbbbbbbbbb" } };
    const deps = { reputation: async () => "good" as const, now: () => T0 };
    expect((await checkSensitiveAccess(db, session, "billing.portal", "/dashboard", { ...deps, context: async () => known, enabled: true })).decision).toBe("allow");
    expect((await checkSensitiveAccess(db, session, "billing.portal", "/dashboard", { ...deps, context: async () => night, enabled: false })).decision).toBe("allow");
  });

  it("a banned connection is denied", async () => {
    const d = await checkSensitiveAccess(db, { user: { id: userId } }, "privacy.data-report", "/account/privacy", {
      context: async () => EMPTY_CONTEXT,
      reputation: async () => "bad",
      enabled: true,
    });
    expect(d.decision).toBe("deny");
  });

  it("no session: asked to sign in", async () => {
    expect((await checkSensitiveAccess(db, null, "billing.checkout", "/dashboard")).decision).toBe("step_up");
  });
});

describe("#519 the request's context", () => {
  it("reads the platform's location headers and the device cookie; ignores junk", () => {
    const h = new Headers({
      "x-vercel-ip-country": "gb",
      "x-vercel-ip-latitude": "51.5",
      "x-vercel-ip-longitude": "-0.12",
      "x-vercel-ip-timezone": "Europe/London",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/130 Safari/537",
    });
    expect(contextFromHeaders(h, "abcdefabcdefabcdef12")).toEqual({
      deviceId: "abcdefabcdefabcdef12",
      deviceLabel: "Chrome on Windows",
      country: "GB",
      latitude: 51.5,
      longitude: -0.12,
      timezone: "Europe/London",
    });
    const junk = contextFromHeaders(new Headers({ "x-vercel-ip-country": "<x>", "x-vercel-ip-latitude": "999" }), "<script>");
    expect([junk.deviceId, junk.country, junk.latitude]).toEqual([null, null, null]);
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17 Mobile Safari/604")).toBe("Safari on iOS");
  });
});

describe("#519 the new sign-in email's sign-out link", () => {
  it("is signed for one session of one account and expires", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    const t = revokeToken("sess-aaaaaaaaaaaa", userId, now, SECRET);
    expect(revokeTokenSessionId(t)).toBe("sess-aaaaaaaaaaaa");
    expect(verifyRevokeToken(t, userId, now, SECRET)).toBe(true);
    expect(verifyRevokeToken(t, "someone-else", now, SECRET)).toBe(false);
    expect(verifyRevokeToken(t.replace("sess-aaaaaaaaaaaa", "sess-bbbbbbbbbbbb"), userId, now, SECRET)).toBe(false);
    expect(verifyRevokeToken(t, userId, now + 8 * 86_400_000, SECRET)).toBe(false);
    expect(verifyRevokeToken(t, userId, now, "another-secret")).toBe(false);
    expect(verifyRevokeToken("nonsense", userId, now, SECRET)).toBe(false);
  });

  it("the email names the device and country and carries the link, escaped", () => {
    const r = newSignInTemplate.render({
      appName: "K9Coach",
      device: "Chrome <on> Windows",
      country: "FR",
      whenUtc: "2026-11-02 10:00",
      revokeUrl: "https://app.example/sessions/revoke?t=a.b.c",
      securityUrl: "https://app.example/account/security",
    });
    expect(r.subject).toBe("New sign-in to K9Coach");
    expect(r.html).toContain("Chrome &lt;on&gt; Windows");
    expect(r.html).toContain("https://app.example/sessions/revoke?t=a.b.c");
    expect(r.text).toContain("sign that device out");
  });

  it("the page's action signs that session out, and refuses a forged link", async () => {
    const { revokeFromEmailAction } = await import("@/app/sessions/revoke/actions");
    await startSessionRecord(db, { sessionId: "sess-cccccccccccc", userId, context: EMPTY_CONTEXT });
    const forged = new FormData();
    forged.set("t", "sess-cccccccccccc.9999999999.forgedsignatureforgedsignature");
    expect((await revokeFromEmailAction(null, forged))?.error).toBeTruthy();
    expect(await isSessionRevoked(db, "sess-cccccccccccc")).toBe(false);
    const fd = new FormData();
    fd.set("t", revokeToken("sess-cccccccccccc", userId));
    expect(await revokeFromEmailAction(null, fd)).toEqual({ done: true });
    expect(await isSessionRevoked(db, "sess-cccccccccccc")).toBe(true);
    expect((await getSessionRecord(db, "sess-cccccccccccc"))?.endReason).toBe("ended_from_email");
  });
});

describe("#377 two-step sign-in is required for an owner-grant account", () => {
  it("a session marked 'not set up' is sent to set it up, and may not make owner-only changes", () => {
    const marked = { user: { role: "owner", mfa: "enroll_required" } };
    expect(mustEnrollTwoStep(marked)).toBe(true);
    expect(() => assertTenantOwner(marked)).toThrow(NotAuthorizedError);
    expect(() => assertTenantOwner(marked)).toThrow(/two-step/);
  });

  it("a verified or not-required session goes on", () => {
    expect(mustEnrollTwoStep({ user: { mfa: "verified" } })).toBe(false);
    expect(mustEnrollTwoStep({ user: { mfa: "none" } })).toBe(false);
    expect(assertTenantOwner({ user: { role: "owner", mfa: "verified" } })).toBe("owner");
    expect(assertTenantOwner({ user: { role: "owner", mfa: "none" } })).toBe("owner");
  });
});
