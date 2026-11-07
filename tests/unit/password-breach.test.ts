// @vitest-environment node
// Refusing passwords known from data breaches (app-business-core issue 356; NIST SP
// 800-63B Rev 4 § 3.1.1.2). The range lookup is driven through a stand-in for Have I
// Been Pwned's range API that records exactly what was sent, so the tests prove both
// halves: a breached password is refused at sign-up, reset and change, and only a
// 5-character hash prefix ever leaves the server — never the password or its hash.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { RegistrationError, registerUser, type AppDatabase } from "@/lib/users";
import { PasswordResetError, createPasswordResetToken, resetPassword } from "@/lib/password-reset";
import { ChangePasswordError, changePassword } from "@/lib/account-security";
import {
  BREACHED_MESSAGE,
  RANGE_URL,
  TIMEOUT_MS,
  breachCheckMode,
  type BreachEnv,
  breachedPasswordError,
  checkBreachedPassword,
  countInRange,
  hashParts,
} from "@/lib/password-breach";

const BREACHED = "Tr0ub4dor&3-breached"; // not on the embedded list: only the range lookup refuses it
const CLEAN = "correct horse battery staple";
const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex").toUpperCase();

/** A stand-in range API: lists BREACHED's suffix (count 42) among padding entries. */
function rangeApi(status = 200) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const breachedSuffix = sha1(BREACHED).slice(5);
    const body = [
      "0018A45C4D1DEF81644B54AB7F969B88D65:0", // padding
      `${breachedSuffix}:42`,
      "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:3",
    ].join("\r\n");
    return new Response(body, { status });
  });
  return { fake: fake as unknown as typeof fetch, urls, headers };
}

const RANGE_ENV: BreachEnv = { PASSWORD_BREACH_CHECK: "range" };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const events = () =>
  vi.mocked(console.warn).mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

describe("only a 5-character hash prefix leaves the server", () => {
  it("splits the SHA-1 into the 5 sent and the 35 kept", () => {
    const { prefix, suffix } = hashParts("password");
    expect(prefix + suffix).toBe(sha1("password"));
    expect(prefix).toHaveLength(5);
    expect(suffix).toHaveLength(35);
  });

  it("asks the range API for the prefix alone, padded, and never sends the password", async () => {
    const api = rangeApi();
    await checkBreachedPassword(BREACHED, { fetch: api.fake, env: RANGE_ENV });
    expect(api.urls).toEqual([`${RANGE_URL}${sha1(BREACHED).slice(0, 5)}`]);
    expect(api.urls[0].startsWith("https://api.pwnedpasswords.com/range/")).toBe(true);
    expect(api.headers[0]["add-padding"]).toBe("true");
    const sent = JSON.stringify({ urls: api.urls, headers: api.headers });
    expect(sent).not.toContain(BREACHED);
    expect(sent).not.toContain(sha1(BREACHED).slice(5));
  });
});

describe("the range answer", () => {
  it("finds the suffix and its count; padding (count 0) and absent are clean", () => {
    const body = "AAA:0\nBBB:7\r\nCCC:x";
    expect(countInRange(body, "BBB")).toBe(7);
    expect(countInRange(body, "AAA")).toBe(0);
    expect(countInRange(body, "CCC")).toBe(0);
    expect(countInRange(body, "DDD")).toBe(0);
    expect(countInRange("bbb:2", "BBB")).toBe(2);
    expect(countInRange("BBB", "BBB")).toBe(0);
  });

  it("breached, clean", async () => {
    const api = rangeApi();
    expect(await checkBreachedPassword(BREACHED, { fetch: api.fake, env: RANGE_ENV })).toEqual({
      status: "breached",
      count: 42,
    });
    expect(await checkBreachedPassword(CLEAN, { fetch: api.fake, env: RANGE_ENV })).toEqual({
      status: "clean",
    });
  });
});

describe("the service out of reach: accepted, and logged", () => {
  it("an error answer", async () => {
    const api = rangeApi(503);
    expect(await checkBreachedPassword(BREACHED, { fetch: api.fake, env: RANGE_ENV })).toEqual({
      status: "unavailable",
    });
    expect(events()).toEqual([
      expect.objectContaining({ security_event: "password_breach_check_unavailable", reason: "answered 503" }),
    ]);
  });

  it("a network failure or time-out, with the time limit set", async () => {
    let signal: AbortSignal | undefined;
    const failing = vi.fn(async (_u: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await checkBreachedPassword(BREACHED, { fetch: failing, env: RANGE_ENV })).toEqual({
      status: "unavailable",
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(events()[0]).toMatchObject({ security_event: "password_breach_check_unavailable", reason: "TimeoutError" });
  });

  it("a thrown non-error", async () => {
    const odd = vi.fn(async () => {
      throw "odd";
    }) as unknown as typeof fetch;
    expect(await checkBreachedPassword(BREACHED, { fetch: odd, env: RANGE_ENV })).toEqual({ status: "unavailable" });
    expect(events()[0]).toMatchObject({ reason: "error" });
  });

  it("breachedPasswordError lets an unchecked password through", async () => {
    expect(await breachedPasswordError(BREACHED, "signup", { fetch: rangeApi(500).fake, env: RANGE_ENV })).toBeNull();
  });
});

describe("where the lookup runs (both states)", () => {
  it("always on a deployed app, even with the test switch set", () => {
    expect(breachCheckMode({ VERCEL_ENV: "production", RATE_LIMIT_ALLOW_IN_MEMORY: "true" })).toBe("range");
    expect(breachCheckMode({ VERCEL_ENV: "preview" })).toBe("range");
    expect(breachCheckMode({})).toBe("range");
  });

  it("skipped only in the safe test environment, unless forced on", async () => {
    const safe: BreachEnv = { RATE_LIMIT_ALLOW_IN_MEMORY: "true" };
    expect(breachCheckMode(safe)).toBe("skipped");
    expect(breachCheckMode({ ...safe, PASSWORD_BREACH_CHECK: "range" })).toBe("range");
    const api = rangeApi();
    expect(await checkBreachedPassword(BREACHED, { fetch: api.fake, env: safe })).toEqual({ status: "skipped" });
    expect(api.urls).toEqual([]);
  });

  it("uses the process environment and the global fetch by default", async () => {
    vi.stubEnv("PASSWORD_BREACH_CHECK", "range");
    const api = rangeApi();
    vi.stubGlobal("fetch", api.fake);
    expect(await checkBreachedPassword(BREACHED)).toEqual({ status: "breached", count: 42 });
    vi.stubEnv("PASSWORD_BREACH_CHECK", "");
    expect(await checkBreachedPassword(BREACHED)).toEqual({ status: "skipped" });
  });
});

describe("refused wherever a new password is set", () => {
  let client: Client;
  let db: AppDatabase;

  beforeEach(async () => {
    client = createMigrationDatabase(":memory:");
    await runMigrations(client);
    db = drizzle(client) as AppDatabase;
    vi.stubEnv("PASSWORD_BREACH_CHECK", "range");
    vi.stubGlobal("fetch", rangeApi().fake);
  });
  afterEach(() => client.close());

  it("sign-up", async () => {
    const err = await registerUser(db, { email: "a@example.com", password: BREACHED }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistrationError);
    expect(err).toMatchObject({ code: "weak_password", message: BREACHED_MESSAGE });
    expect(events()).toContainEqual(expect.objectContaining({ security_event: "password_breached_refused", where: "signup" }));
    await expect(registerUser(db, { email: "b@example.com", password: CLEAN })).resolves.toMatchObject({ email: "b@example.com" });
  });

  it("password reset, before the link is used up", async () => {
    const user = await registerUser(db, { email: "r@example.com", password: CLEAN });
    const { token } = await createPasswordResetToken(db, user.id);
    const err = await resetPassword(db, token, BREACHED).catch((e) => e);
    expect(err).toBeInstanceOf(PasswordResetError);
    expect(err).toMatchObject({ code: "weak_password", message: BREACHED_MESSAGE });
    await expect(resetPassword(db, token, `${CLEAN} two`)).resolves.toEqual({ userId: user.id });
  });

  it("password change", async () => {
    const user = await registerUser(db, { email: "c@example.com", password: CLEAN });
    const err = await changePassword(db, user.id, CLEAN, BREACHED).catch((e) => e);
    expect(err).toBeInstanceOf(ChangePasswordError);
    expect(err).toMatchObject({ code: "weak_password", message: BREACHED_MESSAGE });
    await expect(changePassword(db, user.id, CLEAN, `${CLEAN} two`)).resolves.toBeUndefined();
  });
});
