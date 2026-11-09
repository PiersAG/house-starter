// The load-test plan (config/load-test.ts; app-business-core #356, tool #705).
// Holds the plan to the words of the requirements it carries, and the target
// guard to "a local build or the proof app only, never a live customer app".

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertLoadTarget, LOAD_TEST, slug, userAddress } from "@/config/load-test";
import { ROUTE_LIMITS } from "@/config/rate-limits";

const APP = join(__dirname, "..", "..", "app");
// lib/abuse/route-limit.ts SAFE_TEST_FACTOR (that module is server-only).
const SAFE_TEST_FACTOR = 10;

describe("load-test plan", () => {
  it("simulates at least 100 concurrent users (Matt Murphy #3)", () => {
    expect(LOAD_TEST.concurrentUsers).toBeGreaterThanOrEqual(100);
    expect(LOAD_TEST.holdSeconds).toBeGreaterThan(0);
  });

  it("includes sign-up, which makes a database per account, before the signed-in steps", () => {
    const names = LOAD_TEST.journey.map((s) => s.name);
    expect(names).toContain("sign up");
    const firstSignedIn = LOAD_TEST.journey.findIndex((s) => s.signedIn);
    expect(names.indexOf("sign up")).toBeLessThan(firstSignedIn);
    expect(names.indexOf("sign in")).toBeLessThan(firstSignedIn);
  });

  it("names only routes the template has", () => {
    for (const step of [...LOAD_TEST.journey.map((s) => s.path), ...LOAD_TEST.flood.paths]) {
      if (step.startsWith("/api/auth/callback/") || step === "/api/auth/csrf") {
        expect(existsSync(join(APP, "api", "auth", "[...nextauth]", "route.ts"))).toBe(true);
        continue;
      }
      const dir = join(APP, ...step.split("/").filter(Boolean));
      const files = existsSync(dir) ? readdirSync(dir) : [];
      expect(files.some((f) => f === "page.tsx" || f === "route.ts"), step).toBe(true);
    }
  });

  it("tests the rate limits under load (Matt Murphy #243): 429 with Retry-After, never a 5xx", () => {
    expect(LOAD_TEST.flood.expect.refusedWith).toBe(429);
    expect(LOAD_TEST.flood.expect.retryAfterHeader).toBe(true);
    expect(LOAD_TEST.flood.expect.maxServerErrors).toBe(0);
    expect(LOAD_TEST.pass.maxServerErrors).toBe(0);
  });

  it("floods past the health limit even at the test environment's tenfold limits", () => {
    const { perClient } = ROUTE_LIMITS["public.health"];
    const tenfold = perClient.limit * SAFE_TEST_FACTOR * (LOAD_TEST.flood.seconds / perClient.windowSeconds);
    expect(LOAD_TEST.flood.requestsPerSecondPerPath * LOAD_TEST.flood.seconds).toBeGreaterThan(tenfold);
  });

  it("tests CORS under the same load (Matt Murphy #243's 'cores')", () => {
    expect(LOAD_TEST.cors.refusedWith).toBe(403);
    expect(LOAD_TEST.cors.foreignOrigin).toMatch(/^https:\/\/[^/]+\.example$/);
    expect(LOAD_TEST.cors.address).not.toBe(LOAD_TEST.flood.address);
  });

  it("keeps sign-ups coming while the 100 users hold", () => {
    expect(LOAD_TEST.newSignUpEverySeconds).toBeGreaterThan(0);
    expect(LOAD_TEST.journey.filter((s) => s.repeats).every((s) => s.method === "GET")).toBe(true);
    expect(LOAD_TEST.journey.find((s) => s.name === "sign up")?.repeats).toBe(false);
  });

  it("gives every virtual user its own documentation address, apart from the flood's", () => {
    const addresses = Array.from({ length: LOAD_TEST.concurrentUsers }, (_, n) => userAddress(n));
    expect(new Set(addresses).size).toBe(LOAD_TEST.concurrentUsers);
    expect(addresses).not.toContain(LOAD_TEST.flood.address);
    for (const a of addresses) expect(LOAD_TEST.addressRanges.some((r) => a.startsWith(r))).toBe(true);
    expect(() => userAddress(-1)).toThrow();
    expect(() => userAddress(10_000)).toThrow();
  });

  it("names metrics k6 accepts", () => {
    for (const name of [...LOAD_TEST.journey.map((s) => s.name), ...LOAD_TEST.flood.paths]) {
      expect(slug(name)).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it("runs against a locally served copy only, never a live or deployed address", () => {
    for (const ok of ["http://127.0.0.1:3000", "http://localhost:3100", "http://[::1]:3000"]) {
      expect(assertLoadTarget(ok).port).not.toBe("");
    }
    for (const bad of [
      "https://k9coach.example",
      "https://k9coach-preview-piers-gibbard-s-projects.vercel.app",
      "http://10.0.0.5:3000",
      "https://127.0.0.1:3000",
      "http://127.0.0.1.nip.io:3000",
    ]) {
      expect(() => assertLoadTarget(bad), bad).toThrow(/locally served copy/);
    }
  });
});
