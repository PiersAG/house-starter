// @vitest-environment node
// Session records, the device cap, sign-in risk checks and the renewal-time
// session check (app-business-core issues 506, 519, 741; Matt Murphy #133, #89).
// Run against a real in-memory database brought to the current schema, and through
// the real renewal check (lib/revoked-sessions.ts handleTokenRenewal), so what is
// asserted is what production runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import type { JWT } from "next-auth/jwt";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { registerUser, type AppDatabase } from "@/lib/users";
import { handleTokenRenewal, isSessionRevoked, recordSignOut } from "@/lib/revoked-sessions";
import { changePassword, signOutEverywhere } from "@/lib/account-security";
import {
  activeSessions,
  endSessionRecord,
  getSessionRecord,
  startSessionRecord,
} from "@/lib/session/records";
import { checkSessionRecord, onSessionStart } from "@/lib/session/hooks";
import { EMPTY_CONTEXT, type RequestContext } from "@/lib/session/context";
import { MAX_SESSIONS_PER_USER } from "@/config/sessions";

const PASSWORD = "correct horse battery staple";
let client: Client;
let db: AppDatabase;
let userId: string;

const LONDON = { country: "GB", latitude: 51.5, longitude: -0.12 };
const SYDNEY = { country: "AU", latitude: -33.87, longitude: 151.21 };
const PARIS = { country: "FR", latitude: 48.86, longitude: 2.35 };
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  ...EMPTY_CONTEXT,
  deviceId: "device-aaaaaaaaaaaaaaaa",
  deviceLabel: "Chrome on Windows",
  ...LONDON,
  timezone: "Europe/London",
  ...over,
});
const token = (sessionId: string, over: Partial<JWT> = {}): JWT =>
  ({ id: userId, sessionId, renewAfter: 0, authTime: Math.floor(Date.now() / 1000), email: "owner@example.com", ...over }) as JWT;
const ok = { reputation: async () => "good" as const };

beforeEach(async () => {
  client = createMigrationDatabase(":memory:");
  await runMigrations(client);
  db = drizzle(client) as AppDatabase;
  userId = (await registerUser(db, { email: "owner@example.com", password: PASSWORD })).id;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // the sign-out link in the alert is signed with a key derived from it
  process.env.AUTH_SECRET ??= "unit-test-secret";
});
afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});
const events = () =>
  vi.mocked(console.warn).mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

describe("#506 the cap on signed-in devices (Matt Murphy #133: cap concurrent sessions per user)", () => {
  it("starting a session past the cap ends the least recently used one, and its id is refused at renewal", async () => {
    const t0 = Date.parse("2026-11-02T09:00:00Z");
    const ids: string[] = [];
    for (let i = 0; i <= MAX_SESSIONS_PER_USER; i += 1) {
      const id = `session-${i}-aaaaaaaa`;
      ids.push(id);
      const started = await startSessionRecord(db, { sessionId: id, userId, context: ctx(), now: new Date(t0 + i * 60_000) });
      expect(started.evicted).toEqual(i < MAX_SESSIONS_PER_USER ? [] : [ids[0]]);
    }
    const running = await activeSessions(db, userId);
    expect(running.map((r) => r.id)).not.toContain(ids[0]);
    expect(running).toHaveLength(MAX_SESSIONS_PER_USER);
    expect((await getSessionRecord(db, ids[0]))?.endReason).toBe("device_limit");
    // the oldest-session eviction, through the real renewal check
    expect(await isSessionRevoked(db, ids[0])).toBe(true);
    expect(await handleTokenRenewal(token(ids[0]), (j) => isSessionRevoked(db, j), 10)).toBeNull();
    expect(await handleTokenRenewal(token(ids[1]), (j) => isSessionRevoked(db, j), 10)).not.toBeNull();
  });

  it("sessions started in the same second: the first one written is the oldest", async () => {
    const same = new Date("2026-11-02T09:00:00Z");
    for (let i = 0; i <= MAX_SESSIONS_PER_USER; i += 1) {
      const r = await startSessionRecord(db, { sessionId: `tie-${i}-aaaaaaaaaa`, userId, context: ctx(), now: same });
      expect(r.evicted).toEqual(i < MAX_SESSIONS_PER_USER ? [] : ["tie-0-aaaaaaaaaa"]);
    }
  });

  it("a user can end one of their own devices, never another account's", async () => {
    const otherId = (await registerUser(db, { email: "other@example.com", password: PASSWORD })).id;
    await startSessionRecord(db, { sessionId: "mine-aaaaaaaaaa", userId, context: ctx() });
    await startSessionRecord(db, { sessionId: "theirs-aaaaaaaa", userId: otherId, context: ctx() });
    expect(await endSessionRecord(db, { userId, sessionId: "theirs-aaaaaaaa", reason: "ended_by_user" })).toBe(false);
    expect(await isSessionRevoked(db, "theirs-aaaaaaaa")).toBe(false);
    expect(await endSessionRecord(db, { userId, sessionId: "mine-aaaaaaaaaa", reason: "ended_by_user" })).toBe(true);
    expect(await isSessionRevoked(db, "mine-aaaaaaaaaa")).toBe(true);
  });

  it("sign out everywhere, a password change and a sign-out mark the device list ended", async () => {
    await startSessionRecord(db, { sessionId: "a-aaaaaaaaaaaa", userId, context: ctx() });
    await startSessionRecord(db, { sessionId: "b-aaaaaaaaaaaa", userId, context: ctx() });
    await signOutEverywhere(db, userId);
    expect(await activeSessions(db, userId)).toHaveLength(0);
    await startSessionRecord(db, { sessionId: "c-aaaaaaaaaaaa", userId, context: ctx() });
    await changePassword(db, userId, PASSWORD, "a new and different passphrase");
    expect(await activeSessions(db, userId)).toHaveLength(0);
    await startSessionRecord(db, { sessionId: "d-aaaaaaaaaaaa", userId, context: ctx() });
    await recordSignOut(db, { token: token("d-aaaaaaaaaaaa") });
    expect((await getSessionRecord(db, "d-aaaaaaaaaaaa"))?.endReason).toBe("signed_out");
  });

  it("a removed device is refused at its next check (and at once under the strict policy)", async () => {
    await startSessionRecord(db, { sessionId: "gone-aaaaaaaaaa", userId, context: ctx() });
    await endSessionRecord(db, { userId, sessionId: "gone-aaaaaaaaaa", reason: "ended_by_user" });
    expect(await checkSessionRecord(db, token("gone-aaaaaaaaaa"), 100, { context: async () => ctx(), ...ok })).toBe("end");
  });
});

describe("#519 sign-in risk checks (Matt Murphy #89)", () => {
  it("a sign-in from a new device in a new country emails the owner a sign-out link", async () => {
    const sendEmail = vi.fn(async () => true);
    const deps = { sendEmail, baseUrl: () => "https://app.example", appName: async () => "App", riskChecks: true };
    await onSessionStart(db, token("first-aaaaaaaaa"), { ...deps, context: async () => ctx() });
    expect(sendEmail).not.toHaveBeenCalled(); // the first sign-in has nothing to compare with
    await onSessionStart(db, token("same-device-aaa"), { ...deps, context: async () => ctx({ ...SYDNEY }) });
    expect(sendEmail).not.toHaveBeenCalled(); // a known device is familiar, wherever it is
    await onSessionStart(db, token("new-device-aaaa"), {
      ...deps,
      context: async () => ctx({ deviceId: "device-bbbbbbbbbbbbbbbb", ...PARIS }),
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, data] = sendEmail.mock.calls[0] as unknown as [string, { revokeUrl: string; country: string }];
    expect(to).toBe("owner@example.com");
    expect(data.country).toBe("FR");
    expect(data.revokeUrl).toMatch(/^https:\/\/app\.example\/sessions\/revoke\?t=new-device-aaaa\./);
    expect(events().some((e) => e.security_event === "sign_in_unfamiliar")).toBe(true);
  });

  it("with the risk checks OFF, no alert is sent (both states)", async () => {
    const sendEmail = vi.fn(async () => true);
    const deps = { sendEmail, baseUrl: () => "https://app.example", appName: async () => "App", riskChecks: false };
    await onSessionStart(db, token("first-aaaaaaaaa"), { ...deps, context: async () => ctx() });
    await onSessionStart(db, token("new-device-aaaa"), {
      ...deps,
      context: async () => ctx({ deviceId: "device-bbbbbbbbbbbbbbbb", ...PARIS }),
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a session used from two places no one could travel between is ended (impossible travel)", async () => {
    const t0 = Date.parse("2026-11-02T09:00:00Z");
    await startSessionRecord(db, { sessionId: "travel-aaaaaaaa", userId, context: ctx(), now: new Date(t0) });
    const tenMinutesLater = (t0 + 10 * 60_000) / 1000;
    expect(
      await checkSessionRecord(db, token("travel-aaaaaaaa"), tenMinutesLater, {
        context: async () => ctx({ ...SYDNEY }),
        riskChecks: true,
        ...ok,
      }),
    ).toBe("end");
    expect((await getSessionRecord(db, "travel-aaaaaaaa"))?.endReason).toBe("impossible_travel");
    expect(await isSessionRevoked(db, "travel-aaaaaaaa")).toBe(true);
    expect(events().some((e) => e.security_event === "session_impossible_travel")).toBe(true);
  });

  it("the same journey over a day is possible; and with the risk checks OFF the session goes on (both states)", async () => {
    const t0 = Date.parse("2026-11-02T09:00:00Z");
    await startSessionRecord(db, { sessionId: "flight-aaaaaaaa", userId, context: ctx(), now: new Date(t0) });
    const dayLater = (t0 + 26 * 3_600_000) / 1000;
    expect(
      // the travel rule only: the 8-hour life of "strict" is tested in session-policy.test.ts
      await checkSessionRecord(db, token("flight-aaaaaaaa"), dayLater, { context: async () => ctx({ ...SYDNEY }), ...ok, contextAccess: false, policy: "renewal" }),
    ).toBe("ok");
    await startSessionRecord(db, { sessionId: "off-aaaaaaaaaaa", userId, context: ctx(), now: new Date(t0) });
    expect(
      await checkSessionRecord(db, token("off-aaaaaaaaaaa"), (t0 + 600_000) / 1000, {
        context: async () => ctx({ ...SYDNEY }),
        riskChecks: false,
        contextAccess: false,
        ...ok,
      }),
    ).toBe("ok");
  });
});

describe("#741 continuous session risk scoring", () => {
  it("a banned connection ends the session; a throttled one only raises its score", async () => {
    await startSessionRecord(db, { sessionId: "risky-aaaaaaaaa", userId, context: ctx() });
    expect(
      await checkSessionRecord(db, token("risky-aaaaaaaaa"), Date.now() / 1000, {
        context: async () => ctx(),
        reputation: async () => "suspect",
        contextAccess: true,
      }),
    ).toBe("ok");
    expect((await getSessionRecord(db, "risky-aaaaaaaaa"))?.riskScore).toBe(50);
    expect(
      await checkSessionRecord(db, token("risky-aaaaaaaaa"), Date.now() / 1000, {
        context: async () => ctx(),
        reputation: async () => "bad",
        contextAccess: true,
      }),
    ).toBe("end");
    expect((await getSessionRecord(db, "risky-aaaaaaaaa"))?.endReason).toBe("risk");
  });

  it("with context-aware access OFF the score is not kept (both states)", async () => {
    await startSessionRecord(db, { sessionId: "calm-aaaaaaaaaa", userId, context: ctx() });
    expect(
      await checkSessionRecord(db, token("calm-aaaaaaaaaa"), Date.now() / 1000, {
        context: async () => ctx(),
        reputation: async () => "bad",
        contextAccess: false,
      }),
    ).toBe("ok");
  });

  it("a session from before records existed is recorded at its first check, not refused", async () => {
    expect(await checkSessionRecord(db, token("legacy-aaaaaaaa"), Date.now() / 1000, { context: async () => ctx(), ...ok })).toBe("ok");
    expect(await getSessionRecord(db, "legacy-aaaaaaaa")).toBeTruthy();
  });

  it("fails closed: a check that cannot run ends the session, and renewal refuses it", async () => {
    const broken = { select: () => { throw new Error("database down"); } } as unknown as AppDatabase;
    expect(await checkSessionRecord(broken, token("x-aaaaaaaaaaaaa"), 1, { context: async () => ctx(), ...ok })).toBe("end");
    const renewed = await handleTokenRenewal(token("x-aaaaaaaaaaaaa"), async () => false, 10, undefined, undefined, async () => {
      throw new Error("boom");
    });
    expect(renewed).toBeNull();
    const fine = await handleTokenRenewal(token("x-aaaaaaaaaaaaa"), async () => false, 10, undefined, undefined, async () => "ok");
    expect(fine).not.toBeNull();
  });
});
