// Auth-throttling tests (SEC.42).
//
// Behavioural, not structural: the point of lib/auth-rate-limit.ts is that a
// surface and its API twin land in the SAME bucket, that the provisioning
// ceiling is a separate and tighter one, and that a refusal thrown from inside
// NextAuth's authorize() is still recognisable after the framework has wrapped
// it. Each of those is asserted here rather than assumed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const headersMock = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ headers: headersMock }));

import {
  AUTH_RATE_LIMIT_MARKER,
  AUTH_RATE_LIMITS,
  AuthRateLimitError,
  checkAuthRateLimit,
  guardAuthAttempt,
  isAuthRateLimitError,
} from "@/lib/auth-rate-limit";
import { resetRateLimiterForTests } from "@/lib/rate-limit";

/** Headers carrying one client IP, in the shape next/headers returns. */
function fakeHeaders(ip: string) {
  return {
    get: (name: string) =>
      name.toLowerCase() === "x-forwarded-for" ? ip : null,
  };
}

beforeEach(() => {
  // The in-memory stand-in is the store under test here; the shared-store
  // adapter has its own tests in rate-limit.test.ts.
  process.env.RATE_LIMIT_ALLOW_IN_MEMORY = "true";
  delete process.env.RATE_LIMIT_STORE_URL;
  resetRateLimiterForTests();
  headersMock.mockReset();
});

afterEach(() => {
  resetRateLimiterForTests();
  delete process.env.RATE_LIMIT_ALLOW_IN_MEMORY;
});

describe("AUTH_RATE_LIMITS", () => {
  it("gives every auth surface a limit", () => {
    for (const [name, config] of Object.entries(AUTH_RATE_LIMITS)) {
      expect(config.bucket, `${name} has no bucket`).toBeTruthy();
      expect(config.limit, `${name} has no limit`).toBeGreaterThan(0);
      expect(config.windowSeconds, `${name} has no window`).toBeGreaterThan(0);
    }
  });

  it("caps provisioning far more tightly than signup requests — a database is not a request", () => {
    const perHour = (c: { limit: number; windowSeconds: number }) =>
      (c.limit * 3600) / c.windowSeconds;
    expect(perHour(AUTH_RATE_LIMITS.signupProvision)).toBeLessThan(
      perHour(AUTH_RATE_LIMITS.signup),
    );
  });
});

describe("checkAuthRateLimit", () => {
  it("blocks once the limit is spent, and reports how long to wait", async () => {
    const config = AUTH_RATE_LIMITS.signup;
    let last;
    for (let i = 0; i < config.limit; i += 1) {
      last = await checkAuthRateLimit(config, fakeHeaders("1.2.3.4"));
      expect(last.allowed).toBe(true);
    }
    const refused = await checkAuthRateLimit(config, fakeHeaders("1.2.3.4"));
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(last?.remaining).toBe(0);
  });

  it("one client's abuse never blocks another client", async () => {
    const config = AUTH_RATE_LIMITS.signup;
    for (let i = 0; i <= config.limit; i += 1) {
      await checkAuthRateLimit(config, fakeHeaders("1.2.3.4"));
    }
    const other = await checkAuthRateLimit(config, fakeHeaders("5.6.7.8"));
    expect(other.allowed).toBe(true);
  });

  it("a server action and its API twin share ONE budget", async () => {
    // THE POINT OF THE MODULE. Two separate limits would let an attacker spend
    // both by alternating surfaces, which is not a limit — it is two.
    const config = AUTH_RATE_LIMITS.signup;
    for (let i = 0; i < config.limit; i += 1) {
      // the API twin: headers taken from the Request
      await checkAuthRateLimit(config, fakeHeaders("9.9.9.9"));
    }
    // the server action: headers taken from next/headers, same client
    headersMock.mockResolvedValue(fakeHeaders("9.9.9.9"));
    const viaAction = await guardAuthAttempt(config);
    expect(viaAction.allowed).toBe(false);
  });

  it("separate surfaces do NOT share a budget with each other", async () => {
    for (let i = 0; i <= AUTH_RATE_LIMITS.signup.limit; i += 1) {
      await checkAuthRateLimit(AUTH_RATE_LIMITS.signup, fakeHeaders("4.4.4.4"));
    }
    const login = await checkAuthRateLimit(
      AUTH_RATE_LIMITS.login,
      fakeHeaders("4.4.4.4"),
    );
    expect(login.allowed).toBe(true);
  });

  it("falls back to x-real-ip, and to a constant when the client is unknown", async () => {
    const realIp = {
      get: (n: string) => (n === "x-real-ip" ? "7.7.7.7" : null),
    };
    const nothing = { get: () => null };
    expect(
      (await checkAuthRateLimit(AUTH_RATE_LIMITS.login, realIp)).allowed,
    ).toBe(true);
    expect(
      (await checkAuthRateLimit(AUTH_RATE_LIMITS.login, nothing)).allowed,
    ).toBe(true);
  });
});

describe("guardAuthAttempt", () => {
  it("reads the ambient request headers", async () => {
    headersMock.mockResolvedValue(fakeHeaders("2.2.2.2"));
    const result = await guardAuthAttempt(AUTH_RATE_LIMITS.login);
    expect(result.allowed).toBe(true);
    expect(headersMock).toHaveBeenCalled();
  });
});

describe("isAuthRateLimitError", () => {
  it("recognises the refusal itself", () => {
    expect(isAuthRateLimitError(new AuthRateLimitError(30))).toBe(true);
  });

  it("recognises it through NextAuth's { err } wrapper", () => {
    // The shape next-auth v5 wraps an authorize() throw in.
    const wrapped = new Error("CallbackRouteError");
    (wrapped as Error & { cause?: unknown }).cause = {
      err: new AuthRateLimitError(30),
      provider: "credentials",
    };
    expect(isAuthRateLimitError(wrapped)).toBe(true);
  });

  it("recognises it through a plain cause chain", () => {
    const inner = new AuthRateLimitError(30);
    const outer = new Error("outer", { cause: inner });
    expect(isAuthRateLimitError(outer)).toBe(true);
  });

  it("recognises a refusal that crossed a boundary as a plain Error", () => {
    // The reason the check is on a marker string and not on the class: an error
    // that is re-wrapped or serialised on its way out of the framework arrives
    // as a plain Error, and the user still must not be told their password is
    // wrong.
    expect(
      isAuthRateLimitError(
        new Error(`CallbackRouteError: ${AUTH_RATE_LIMIT_MARKER}`),
      ),
    ).toBe(true);
  });

  it("does not mistake a wrong password for a throttle", () => {
    expect(isAuthRateLimitError(new Error("CredentialsSignin"))).toBe(false);
    expect(isAuthRateLimitError(null)).toBe(false);
    expect(isAuthRateLimitError("nope")).toBe(false);
  });

  it("terminates on a cyclic cause chain rather than hanging the request", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(isAuthRateLimitError(a)).toBe(false);
  });

  it("carries the retry hint", () => {
    expect(new AuthRateLimitError(42).retryAfterSeconds).toBe(42);
  });
});
