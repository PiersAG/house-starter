// Rate-limit tests (spec C4b, Deliverable C).
//
// Exercises lib/rate-limit.ts behaviourally: requests under the limit pass,
// requests over it are blocked, window expiry resets the counter, and one
// key's abuse never blocks another key. The shared-store (Redis REST) adapter
// is driven through an injected fake fetch so the wire protocol (INCR/EXPIRE/
// TTL, auth header, error propagation) is asserted without a live Redis. The
// environment selection rules are tested fail-closed: no store configured and
// no explicit safe-environment flag means refuse to start.

import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryRateLimitStore,
  RedisRestRateLimitStore,
  clientKeyFromHeaders,
  createRateLimitStore,
  getRateLimiter,
  resetRateLimiterForTests,
  type FetchLike,
  type RateLimitOptions,
} from "@/lib/rate-limit";

const OPTS: RateLimitOptions = { limit: 3, windowSeconds: 60 };

describe("InMemoryRateLimitStore — fixed window behaviour", () => {
  it("allows requests under the limit and counts remaining down", async () => {
    const now = 1_000_000;
    const store = new InMemoryRateLimitStore(() => now);

    expect(await store.hit("user_a", OPTS)).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 60,
    });
    expect(await store.hit("user_a", OPTS)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(await store.hit("user_a", OPTS)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("blocks the request that exceeds the limit", async () => {
    const now = 1_000_000;
    const store = new InMemoryRateLimitStore(() => now);
    for (let i = 0; i < OPTS.limit; i++) await store.hit("user_a", OPTS);

    const fourth = await store.hit("user_a", OPTS);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets the counter after the window expires", async () => {
    let now = 1_000_000;
    const store = new InMemoryRateLimitStore(() => now);
    for (let i = 0; i <= OPTS.limit; i++) await store.hit("user_a", OPTS);
    expect((await store.hit("user_a", OPTS)).allowed).toBe(false);

    now += OPTS.windowSeconds * 1000 + 1;
    const afterExpiry = await store.hit("user_a", OPTS);
    expect(afterExpiry.allowed).toBe(true);
    expect(afterExpiry.remaining).toBe(OPTS.limit - 1);
  });

  it("isolates keys: one user's abuse does not block another", async () => {
    const now = 1_000_000;
    const store = new InMemoryRateLimitStore(() => now);
    for (let i = 0; i < 10; i++) await store.hit("abuser", OPTS);
    expect((await store.hit("abuser", OPTS)).allowed).toBe(false);

    expect((await store.hit("innocent", OPTS)).allowed).toBe(true);
  });

  it("reports retry-after from the window remainder, floored at 1 second", async () => {
    let now = 1_000_000;
    const store = new InMemoryRateLimitStore(() => now);
    await store.hit("user_a", OPTS);

    now += (OPTS.windowSeconds - 1) * 1000 + 900; // 100ms before reset
    const nearReset = await store.hit("user_a", OPTS);
    expect(nearReset.retryAfterSeconds).toBe(1);
  });

  it("works with the default clock when none is injected", async () => {
    const store = new InMemoryRateLimitStore();
    expect((await store.hit("user_a", OPTS)).allowed).toBe(true);
  });
});

/** Fake Upstash-style REST endpoint: records calls, scripts responses. */
function fakeRedis(state: { count: number; ttl: number }) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push(input);
    expect(init?.method).toBe("POST");
    const path = input.split("/").slice(3).join("/"); // strip scheme+host
    let result: unknown = null;
    if (path.startsWith("incr/")) result = ++state.count;
    else if (path.startsWith("expire/")) result = 1;
    else if (path.startsWith("ttl/")) result = state.ttl;
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { calls, fetchImpl };
}

describe("RedisRestRateLimitStore — shared-store adapter", () => {
  it("allows under the limit and sets the expiry on the first hit only", async () => {
    const state = { count: 0, ttl: 60 };
    const { calls, fetchImpl } = fakeRedis(state);
    const store = new RedisRestRateLimitStore("https://redis.test", "tok", fetchImpl);

    const first = await store.hit("login:1.2.3.4", OPTS);
    expect(first).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 60 });
    expect(calls.some((c) => c.includes("/expire/"))).toBe(true);

    const callsBefore = calls.length;
    await store.hit("login:1.2.3.4", OPTS);
    const newCalls = calls.slice(callsBefore);
    expect(newCalls.some((c) => c.includes("/expire/"))).toBe(false);
  });

  it("blocks once the shared counter exceeds the limit", async () => {
    const state = { count: OPTS.limit, ttl: 42 }; // limit already consumed elsewhere
    const store = new RedisRestRateLimitStore(
      "https://redis.test",
      "tok",
      fakeRedis(state).fetchImpl,
    );

    const over = await store.hit("login:1.2.3.4", OPTS);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
    expect(over.retryAfterSeconds).toBe(42); // TTL from the store, not the default
  });

  it("falls back to the window length when TTL is not positive", async () => {
    const state = { count: 0, ttl: -1 };
    const store = new RedisRestRateLimitStore(
      "https://redis.test",
      "tok",
      fakeRedis(state).fetchImpl,
    );
    const result = await store.hit("k", OPTS);
    expect(result.retryAfterSeconds).toBe(OPTS.windowSeconds);
  });

  it("sends the bearer token and URL-encodes the key", async () => {
    const seen: { url?: string; auth?: string } = {};
    const fetchImpl: FetchLike = async (input, init) => {
      seen.url ??= input;
      seen.auth ??= init?.headers?.Authorization;
      return { ok: true, status: 200, json: async () => ({ result: 1 }) };
    };
    const store = new RedisRestRateLimitStore(
      "https://redis.test/", // trailing slash must be trimmed
      "secret-token",
      fetchImpl,
    );
    await store.hit("login/1.2.3.4", OPTS);
    expect(seen.auth).toBe("Bearer secret-token");
    expect(seen.url).toBe("https://redis.test/incr/login%2F1.2.3.4");
  });

  it("propagates store failures loudly (fail closed, not open)", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const store = new RedisRestRateLimitStore("https://redis.test", "tok", fetchImpl);
    await expect(store.hit("k", OPTS)).rejects.toThrowError(/503.*"incr"/);
  });
});

describe("createRateLimitStore — environment selection rules", () => {
  const noopFetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: 1 }),
  });

  it("selects the shared store when RATE_LIMIT_STORE_URL + TOKEN are set", () => {
    const store = createRateLimitStore(
      { RATE_LIMIT_STORE_URL: "https://redis.test", RATE_LIMIT_STORE_TOKEN: "tok" },
      noopFetch,
    );
    expect(store).toBeInstanceOf(RedisRestRateLimitStore);
  });

  it("refuses a store URL without its token, naming the missing variable", () => {
    expect(() =>
      createRateLimitStore({ RATE_LIMIT_STORE_URL: "https://redis.test" }, noopFetch),
    ).toThrowError(/RATE_LIMIT_STORE_TOKEN is missing/);
  });

  it("allows the in-memory stand-in only via the explicit safe-environment flag", () => {
    const store = createRateLimitStore(
      { RATE_LIMIT_ALLOW_IN_MEMORY: "true" },
      noopFetch,
    );
    expect(store).toBeInstanceOf(InMemoryRateLimitStore);
  });

  it("fails loudly when nothing is configured — never a silent in-memory default", () => {
    expect(() => createRateLimitStore({}, noopFetch)).toThrowError(
      /Rate limiting is not configured[\s\S]*RATE_LIMIT_STORE_URL/,
    );
    // "false", empty, and whitespace-only values must not sneak past the flag.
    expect(() =>
      createRateLimitStore({ RATE_LIMIT_ALLOW_IN_MEMORY: "false" }, noopFetch),
    ).toThrowError(/Rate limiting is not configured/);
    expect(() =>
      createRateLimitStore({ RATE_LIMIT_STORE_URL: "   " }, noopFetch),
    ).toThrowError(/Rate limiting is not configured/);
  });
});

describe("getRateLimiter — process-wide singleton", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_ALLOW_IN_MEMORY;
    delete process.env.RATE_LIMIT_STORE_URL;
    delete process.env.RATE_LIMIT_STORE_TOKEN;
    resetRateLimiterForTests();
  });

  it("builds once from the real environment and reuses the instance", () => {
    process.env.RATE_LIMIT_ALLOW_IN_MEMORY = "true";
    resetRateLimiterForTests();

    const first = getRateLimiter();
    const second = getRateLimiter();
    expect(first).toBeInstanceOf(InMemoryRateLimitStore);
    expect(second).toBe(first); // shared counters across route bundles

    resetRateLimiterForTests();
    expect(getRateLimiter()).not.toBe(first);
  });
});

describe("clientKeyFromHeaders", () => {
  it("uses the first x-forwarded-for entry", () => {
    const headers = new Headers({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" });
    expect(clientKeyFromHeaders(headers)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip when the forwarded list is unusable", () => {
    const headers = new Headers({
      "x-forwarded-for": " ,10.0.0.1",
      "x-real-ip": "198.51.100.7",
    });
    expect(clientKeyFromHeaders(headers)).toBe("198.51.100.7");
  });

  it("returns 'unknown' when no client header is present", () => {
    expect(clientKeyFromHeaders(new Headers())).toBe("unknown");
  });
});
