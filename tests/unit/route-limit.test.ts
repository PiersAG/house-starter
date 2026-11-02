// @vitest-environment node
//
// Route limits, probing and escalation (app-business-core #787, #748):
// lib/abuse/route-limit.ts against config/rate-limits.ts, driven through the
// in-memory counter store with an injected clock. Each `it` names the
// requirement line it proves.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "198.51.100.9" }) }));

import { ESCALATION, HEALTH_ADAPTIVE, PLAN_MULTIPLIERS, PROBE, ROUTE_LIMITS, planTierFor } from "@/config/rate-limits";
import {
  checkRouteLimit,
  effectiveLimit,
  guardRouteAction,
  healthFactorFromErrors,
  recordBehaviour,
  refusalResponse,
  resetRouteLimitForTests,
  withRouteLimit,
  type RouteLimitDecision,
  type RouteLimitDeps,
} from "@/lib/abuse/route-limit";
import { InMemoryRateLimitStore, RedisRestRateLimitStore, resetRateLimiterForTests, windowKey, type FetchLike } from "@/lib/rate-limit";

const T0 = Date.parse("2026-11-02T10:00:00Z"); // on a minute boundary
let now = T0;
let store: InMemoryRateLimitStore;
let logged: { event: string; fields: Record<string, unknown> }[];

function deps(extra: Partial<RouteLimitDeps> = {}): RouteLimitDeps {
  return {
    store,
    now: () => now,
    healthFactor: async () => 1,
    log: (event, fields) => logged.push({ event, fields }),
    safeTestEnvironment: false,
    ...extra,
  };
}

const ip = (n: number) => new Headers({ "x-real-ip": `203.0.113.${n}` });

/** n requests, each 0.1 s apart (so they never trip the one-second probe check). */
async function burst(n: number, input: Parameters<typeof checkRouteLimit>[0], d = deps()) {
  const out: RouteLimitDecision[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await checkRouteLimit(input, d));
    now += 100;
  }
  return out;
}

beforeEach(() => {
  now = T0;
  store = new InMemoryRateLimitStore(() => now);
  logged = [];
  resetRouteLimitForTests();
  // the module-level store (used by the wrappers) is the safe-environment stand-in
  process.env.RATE_LIMIT_ALLOW_IN_MEMORY = "true";
  delete process.env.VERCEL_ENV;
  resetRateLimiterForTests();
});

describe("layer 1 — hard limits on every route (#787 R0875, R1272)", () => {
  it("'hard limits fixed number of requests per time window hit the wall get a 429'", async () => {
    const limit = ROUTE_LIMITS["settings.write"].perClient.limit; // 30 a minute
    const out = await burst(limit + 1, { route: "settings.write", headers: ip(1) });
    expect(out.slice(0, limit).every((d) => d.allowed)).toBe(true);
    const last = out[limit];
    expect(last).toMatchObject({ allowed: false, reason: "limit", status: 429 });
    const res = refusalResponse(last as Extract<RouteLimitDecision, { allowed: false }>);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "Too many requests. Please wait a moment and try again." });
    expect(logged.filter((l) => l.event === "route_rate_limited")).toHaveLength(1);
  });

  it("'a user can send 1000 requests in a second': the app does not process them all", async () => {
    const out: RouteLimitDecision[] = [];
    for (let i = 0; i < 1000; i++) out.push(await checkRouteLimit({ route: "app.default", headers: ip(2) }, deps()));
    expect(out.filter((d) => d.allowed).length).toBeLessThanOrEqual(PROBE.limit);
  });

  it("an account is limited across addresses (per account as well as per client)", async () => {
    const limit = ROUTE_LIMITS["settings.write"].perAccount.limit;
    const out: RouteLimitDecision[] = [];
    for (let i = 0; i <= limit; i++) {
      out.push(await checkRouteLimit({ route: "settings.write", headers: ip(10 + i), accountId: "u1" }, deps()));
      now += 100;
    }
    expect(out[limit]).toMatchObject({ allowed: false, reason: "limit" });
  });

  it("one client's flood never limits another client", async () => {
    await burst(200, { route: "settings.write", headers: ip(3) });
    expect((await checkRouteLimit({ route: "settings.write", headers: ip(4) }, deps())).allowed).toBe(true);
  });

  it("'your public data endpoints to prevent any bot scraping' (#787 R1232): public routes are limited too", async () => {
    const limit = ROUTE_LIMITS["public.health"].perClient.limit;
    const out = await burst(limit + 1, { route: "public.health", headers: ip(5) });
    expect(out[limit]).toMatchObject({ allowed: false, status: 429 });
  });

  it("the window resets: a refused client is served again in the next window", async () => {
    await burst(31, { route: "settings.write", headers: ip(6) });
    now = T0 + 61_000;
    expect((await checkRouteLimit({ route: "settings.write", headers: ip(6) }, deps())).allowed).toBe(true);
  });
});

describe("layer 3 — limits by price plan (#787, Matt Murphy #186 R0877)", () => {
  it("a paying subscriber's limit is the plan multiple of the base", () => {
    const w = ROUTE_LIMITS["settings.write"].perClient;
    const base = { publicRoute: false, healthFactor: 1, throttled: false } as const;
    expect(effectiveLimit(w, { ...base, plan: "none" })).toBe(w.limit);
    expect(effectiveLimit(w, { ...base, plan: "subscribed" })).toBe(w.limit * PLAN_MULTIPLIERS.subscribed);
  });

  it("a subscriber gets past the base limit; a signed-out client does not", async () => {
    const limit = ROUTE_LIMITS["settings.read"].perClient.limit;
    const paid = await burst(limit + 1, { route: "settings.read", headers: ip(7), accountId: "p1", plan: "subscribed" });
    expect(paid[limit].allowed).toBe(true);
    const anon = await burst(limit + 1, { route: "settings.read", headers: ip(8) });
    expect(anon[limit].allowed).toBe(false);
  });

  it("a public route is never raised by a plan", () => {
    const w = ROUTE_LIMITS["public.health"].perClient;
    expect(effectiveLimit(w, { publicRoute: true, plan: "subscribed", healthFactor: 1, throttled: false })).toBe(w.limit);
  });

  it("a plan cannot be claimed while signed out", async () => {
    const limit = ROUTE_LIMITS["settings.read"].perClient.limit;
    const out = await burst(limit + 1, { route: "settings.read", headers: ip(9), plan: "subscribed" });
    expect(out[limit].allowed).toBe(false);
  });

  it("subscription states map to tiers", () => {
    expect(planTierFor("subscribed")).toBe("subscribed");
    expect(planTierFor("trial")).toBe("trial");
    expect(planTierFor("payment_failed")).toBe("none");
    expect(planTierFor(null)).toBe("none");
  });
});

describe("layer 2 — adaptive limits from the system's health (#787 R0876)", () => {
  it("'the limits adjust based on the system's health': a degraded system halves every limit", async () => {
    const limit = ROUTE_LIMITS["settings.write"].perClient.limit;
    const out = await burst(limit, { route: "settings.write", headers: ip(11) }, deps({ healthFactor: async () => HEALTH_ADAPTIVE.degradedFactor }));
    const allowed = out.filter((d) => d.allowed).length;
    expect(allowed).toBe(Math.floor(limit * HEALTH_ADAPTIVE.degradedFactor));
  });

  it("the health reading comes from the recent error count, cached per instance", async () => {
    const count = vi.fn(async () => HEALTH_ADAPTIVE.degradedErrors + 1);
    expect(await healthFactorFromErrors(() => now, count)).toBe(HEALTH_ADAPTIVE.degradedFactor);
    expect(await healthFactorFromErrors(() => now + 1_000, count)).toBe(HEALTH_ADAPTIVE.degradedFactor);
    expect(count).toHaveBeenCalledTimes(1);
    resetRouteLimitForTests();
    expect(await healthFactorFromErrors(() => now, async () => 0)).toBe(1);
    resetRouteLimitForTests();
    expect(await healthFactorFromErrors(() => now, async () => { throw new Error("no sink"); })).toBe(1);
  });
});

describe("probing and escalation (#748 R0597, R0827)", () => {
  it("'a user hitting the same endpoint 50 times per second … they're probing'", async () => {
    const out: RouteLimitDecision[] = [];
    for (let i = 0; i <= PROBE.limit; i++) out.push(await checkRouteLimit({ route: "app.default", headers: ip(20) }, deps()));
    expect(out.slice(0, PROBE.limit).every((d) => d.allowed)).toBe(true);
    expect(out[PROBE.limit]).toMatchObject({ allowed: false, reason: "probe", status: 429 });
    expect(logged.find((l) => l.event === "route_rate_limited")?.fields.reason).toBe("probe");
  });

  it("a probing ACCOUNT is caught across addresses", async () => {
    const out: RouteLimitDecision[] = [];
    for (let i = 0; i <= PROBE.limit; i++) {
      out.push(await checkRouteLimit({ route: "app.default", headers: ip(100 + i), accountId: "probe" }, deps()));
    }
    expect(out[PROBE.limit]).toMatchObject({ reason: "probe" });
  });

  it("'escalates from throttle to temporary ban': throttle past throttleAt, ban past banAt, ban ends", async () => {
    // limit hits score 1 each: one per window, so step through windows
    const h = ip(21);
    const limit = ROUTE_LIMITS["settings.write"].perClient.limit;
    for (let w = 0; w < ESCALATION.throttleAt; w++) {
      now = T0 + w * 60_000;
      await burst(limit + 1, { route: "settings.write", headers: h });
    }
    expect(logged.some((l) => l.event === "abuse_throttled")).toBe(true);
    // throttled: a quarter of the limit in the next window
    now = T0 + ESCALATION.throttleAt * 60_000;
    const throttled = await burst(limit, { route: "settings.write", headers: h });
    expect(throttled.filter((d) => d.allowed).length).toBe(Math.floor(limit * ESCALATION.throttleFactor));

    // behaviour, not volume: two attack requests take it past banAt
    for (let i = 0; i < 2; i++) {
      await checkRouteLimit({ route: "app.default", headers: h, url: "https://app.example/api/x?id=1' OR '1'='1" }, deps());
    }
    expect(logged.some((l) => l.event === "abuse_banned")).toBe(true);
    const banned = await checkRouteLimit({ route: "app.default", headers: h }, deps());
    expect(banned).toMatchObject({ allowed: false, reason: "banned", status: 429 });
    expect((banned as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(ESCALATION.banSeconds - 5);
    // a temporary ban: served again once it ends (and the strikes have decayed)
    now += (ESCALATION.banSeconds + ESCALATION.strikeWindowSeconds) * 1000;
    expect((await checkRouteLimit({ route: "app.default", headers: h }, deps())).allowed).toBe(true);
  });

  it("behaviour, not just volume: three attack requests ban a client that never hit a limit", async () => {
    const h = ip(22);
    for (let i = 0; i < 3; i++) {
      const d = await checkRouteLimit({ route: "app.default", headers: h, url: "/api/x/../../etc/passwd" }, deps());
      expect(d).toMatchObject({ allowed: false, reason: i < 3 ? "attack" : "banned", status: 403 });
    }
    expect(await checkRouteLimit({ route: "app.default", headers: h }, deps())).toMatchObject({ reason: "banned" });
  });

  it("refused sign-ins score against the client (recordBehaviour)", async () => {
    const h = ip(23);
    const times = Math.ceil(ESCALATION.banAt / ESCALATION.strikes.auth_refused);
    for (let i = 0; i < times; i++) await recordBehaviour(h, "auth_refused", deps());
    expect(await checkRouteLimit({ route: "auth.signin", headers: h }, deps())).toMatchObject({ reason: "banned" });
  });
});

describe("the safe test environment (an e2e suite is one client)", () => {
  it("limits and escalation thresholds are ten times higher there, and only there", async () => {
    const limit = ROUTE_LIMITS["settings.write"].perClient.limit;
    const relaxed = await burst(limit * 10 + 1, { route: "settings.write", headers: ip(50) }, deps({ safeTestEnvironment: true }));
    expect(relaxed.slice(0, limit * 10).every((d) => d.allowed)).toBe(true);
    expect(relaxed[limit * 10]).toMatchObject({ allowed: false, reason: "limit" });
  });

  it("attack payloads are refused the same as deployed", async () => {
    const d = await checkRouteLimit({ route: "app.default", headers: ip(51), url: "/x?q=<script>" }, deps({ safeTestEnvironment: true }));
    expect(d).toMatchObject({ allowed: false, reason: "attack", status: 403 });
  });

  it("a deployed instance is never the safe test environment", async () => {
    process.env.VERCEL_ENV = "preview";
    const { inSafeTestEnvironment } = await import("@/lib/auth-rate-limit");
    expect(inSafeTestEnvironment()).toBe(false);
    delete process.env.VERCEL_ENV;
  });
});

describe("failure modes", () => {
  it("a store failure at run time serves the route and logs it", async () => {
    const broken = new InMemoryRateLimitStore(() => now);
    broken.add = async () => { throw new Error("store down"); };
    const d = await checkRouteLimit({ route: "app.default", headers: ip(30) }, deps({ store: broken }));
    expect(d.allowed).toBe(true);
    expect(logged.map((l) => l.event)).toContain("rate_limit_store_error");
  });

  it("recordBehaviour never throws", async () => {
    const broken = new InMemoryRateLimitStore(() => now);
    broken.add = async () => { throw new Error("store down"); };
    await expect(recordBehaviour(ip(31), "probe", deps({ store: broken }))).resolves.toBeUndefined();
  });
});

describe("wrappers", () => {
  it("withRouteLimit refuses before the handler runs and passes the route's arguments through", async () => {
    const handler = vi.fn(async (_r: Request, ctx: { params: Promise<{ key: string }> }) => new Response((await ctx.params).key));
    const wrapped = withRouteLimit("app.default", handler);
    const ctx = { params: Promise.resolve({ key: "k" }) };
    // the module-level store is the in-memory stand-in in the test environment
    const ok = await wrapped(new Request("https://app.example/api/x", { headers: ip(40) }), ctx);
    expect(await ok.text()).toBe("k");
    const attack = await wrapped(new Request("https://app.example/api/x?q=<script>alert(1)</script>", { headers: ip(41) }), ctx);
    expect(attack.status).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("guardRouteAction reads the ambient request's headers", async () => {
    expect(await guardRouteAction("auth.signin")).toBeNull();
  });
});

describe("store counters (lib/rate-limit.ts)", () => {
  it("windows are aligned to the clock", () => {
    expect(windowKey("k", 60, T0)).toEqual({ key: `k:w60:${T0 / 60_000}`, ttl: 60 });
    expect(windowKey("k", 60, T0 + 15_000).ttl).toBe(45);
  });

  it("the shared store counts with one INCRBY (and one EXPIRE on a window's first hit)", async () => {
    const calls: string[] = [];
    let n = 0;
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url.replace("https://store.example/", ""));
      const cmd = url.split("/")[3];
      return { ok: true, status: 200, json: async () => ({ result: cmd === "incrby" ? ++n : cmd === "get" ? null : "OK" }) };
    };
    const redis = new RedisRestRateLimitStore("https://store.example", "t", fetchImpl, () => T0);
    expect(await redis.add("rl:x", 1, 60)).toBe(1);
    expect(await redis.add("rl:x", 1, 60)).toBe(2);
    expect(calls).toEqual([`incrby/rl%3Ax%3Aw60%3A${T0 / 60_000}/1`, `expire/rl%3Ax%3Aw60%3A${T0 / 60_000}/60`, `incrby/rl%3Ax%3Aw60%3A${T0 / 60_000}/1`]);
    expect(await redis.heldUntil("abuse:ban:x")).toBe(0);
  });

  it("a held marker lasts until its time and no longer", async () => {
    await store.holdUntil("b", Math.floor(T0 / 1000) + 10);
    expect(await store.heldUntil("b")).toBe(Math.floor(T0 / 1000) + 10);
    now = T0 + 11_000;
    expect(await store.heldUntil("b")).toBe(0);
  });
});

describe("the per-account key (lib/abuse/session-account.ts)", () => {
  it("is a hash of the session cookie: stable per session, never the cookie itself, null when signed out", async () => {
    const { sessionAccount } = await import("@/lib/abuse/session-account");
    const req = (cookie?: string) => new Request("https://app.example/x", { headers: cookie ? { cookie } : {} });
    const a = await sessionAccount(req("theme=dark; __Secure-authjs.session-token=abc.def.ghi"));
    const again = await sessionAccount(req("__Secure-authjs.session-token=abc.def.ghi"));
    const other = await sessionAccount(req("authjs.session-token=zzz"));
    const chunked = await sessionAccount(req("authjs.session-token.0=part1; authjs.session-token.1=part2"));
    expect(a?.id).toMatch(/^s:[0-9a-f]{32}$/);
    expect(again).toEqual(a);
    expect(other?.id).not.toBe(a?.id);
    expect(chunked?.id).toMatch(/^s:/);
    expect(a?.id).not.toContain("abc");
    expect(await sessionAccount(req("theme=dark"))).toBeNull();
    expect(await sessionAccount(req())).toBeNull();
  });
});
