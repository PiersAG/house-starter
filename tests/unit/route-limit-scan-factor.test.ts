// @vitest-environment node
//
// The active scan's rate-limit factor (lib/abuse/route-limit.ts safeTestFactor;
// app-business-core issue 533). Read ONLY in the safe test environment; a
// deployed instance keeps factor 1 whatever the variable says, and attack
// payloads are refused the same either way.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "198.51.100.9" }) }));

import { ROUTE_LIMITS } from "@/config/rate-limits";
import {
  checkRouteLimit,
  MAX_SAFE_TEST_FACTOR,
  resetRouteLimitForTests,
  SAFE_TEST_FACTOR,
  safeTestFactor,
  type RouteLimitDecision,
  type RouteLimitDeps,
} from "@/lib/abuse/route-limit";
import { InMemoryRateLimitStore } from "@/lib/rate-limit";

const T0 = Date.parse("2026-11-04T10:00:00Z");
let now = T0;
let store: InMemoryRateLimitStore;

const deps = (extra: Partial<RouteLimitDeps> = {}): RouteLimitDeps => ({
  store,
  now: () => now,
  healthFactor: async () => 1,
  log: () => {},
  safeTestEnvironment: false,
  ...extra,
});
const ip = (n: number) => new Headers({ "x-real-ip": `203.0.113.${n}` });

async function burst(n: number, d: RouteLimitDeps, n0: number) {
  const out: RouteLimitDecision[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await checkRouteLimit({ route: "settings.write", headers: ip(n0) }, d));
    now += 100;
  }
  return out;
}

beforeEach(() => {
  now = T0;
  store = new InMemoryRateLimitStore(() => now);
  resetRouteLimitForTests();
});

describe("safeTestFactor (the scan's setting)", () => {
  it("is ten unless set to a whole number between ten and the maximum", () => {
    expect(safeTestFactor({})).toBe(SAFE_TEST_FACTOR);
    expect(safeTestFactor({ RATE_LIMIT_SAFE_TEST_FACTOR: "1000" })).toBe(1000);
    expect(safeTestFactor({ RATE_LIMIT_SAFE_TEST_FACTOR: String(MAX_SAFE_TEST_FACTOR) })).toBe(MAX_SAFE_TEST_FACTOR);
    for (const bad of ["2", "0", "-5", "1e9", "10.5", "lots", "Infinity", String(MAX_SAFE_TEST_FACTOR + 1)]) {
      expect(safeTestFactor({ RATE_LIMIT_SAFE_TEST_FACTOR: bad }), bad).toBe(SAFE_TEST_FACTOR);
    }
  });

  it("reads process.env by default", () => {
    process.env.RATE_LIMIT_SAFE_TEST_FACTOR = "500";
    try {
      expect(safeTestFactor()).toBe(500);
    } finally {
      delete process.env.RATE_LIMIT_SAFE_TEST_FACTOR;
    }
  });
});

describe("the factor applies in the safe test environment only", () => {
  const limit = ROUTE_LIMITS["settings.write"].perClient.limit;

  it("raises the limits there", async () => {
    const out = await burst(limit * 15 + 1, deps({ safeTestEnvironment: true, safeTestFactor: 15 }), 60);
    expect(out.slice(0, limit * 15).every((d) => d.allowed)).toBe(true);
    expect(out[limit * 15]).toMatchObject({ allowed: false, reason: "limit" });
  });

  it("changes nothing on a deployed instance", async () => {
    const out = await burst(limit + 1, deps({ safeTestEnvironment: false, safeTestFactor: MAX_SAFE_TEST_FACTOR }), 61);
    expect(out.slice(0, limit).every((d) => d.allowed)).toBe(true);
    expect(out[limit]).toMatchObject({ allowed: false, reason: "limit", status: 429 });
  });

  it("still refuses attack payloads", async () => {
    const d = await checkRouteLimit(
      { route: "app.default", headers: ip(62), url: "/x?q=<script>" },
      deps({ safeTestEnvironment: true, safeTestFactor: MAX_SAFE_TEST_FACTOR }),
    );
    expect(d).toMatchObject({ allowed: false, reason: "attack", status: 403 });
  });
});
