// Canonical-URL tests (SEC.42 rider — finding 7, host-header injection).
//
// The property under test is one sentence: a link the app SENDS OUT must never
// be built from anything the caller controls. Every case below is a variation
// on "the Host header said something else".

import { describe, expect, it } from "vitest";
import { canonicalBaseUrl, type AppUrlEnv } from "@/lib/app-url";

const ATTACKER = "https://attacker.example";

describe("canonicalBaseUrl", () => {
  it("prefers the explicitly configured URL over everything", () => {
    const env: AppUrlEnv = {
      APP_CANONICAL_URL: "https://app.example.com",
      AUTH_URL: "https://other.example",
      VERCEL_URL: "deployment.vercel.app",
      VERCEL_ENV: "production",
    };
    expect(canonicalBaseUrl(env, ATTACKER)).toBe("https://app.example.com");
  });

  it("falls back through AUTH_URL, the production host, then this deployment", () => {
    expect(
      canonicalBaseUrl(
        { AUTH_URL: "https://auth.example", VERCEL_ENV: "production" },
        ATTACKER,
      ),
    ).toBe("https://auth.example");
    expect(
      canonicalBaseUrl(
        {
          VERCEL_PROJECT_PRODUCTION_URL: "prod.vercel.app",
          VERCEL_URL: "preview.vercel.app",
          VERCEL_ENV: "production",
        },
        ATTACKER,
      ),
    ).toBe("https://prod.vercel.app");
    expect(
      canonicalBaseUrl(
        { VERCEL_URL: "preview.vercel.app", VERCEL_ENV: "preview" },
        ATTACKER,
      ),
    ).toBe("https://preview.vercel.app");
  });

  it("NEVER uses the request origin in a deployed environment", () => {
    // The whole finding: a forged Host must not reach the reset link.
    expect(
      canonicalBaseUrl(
        { VERCEL_ENV: "preview", VERCEL_URL: "real.vercel.app" },
        ATTACKER,
      ),
    ).not.toContain("attacker");
    expect(() =>
      canonicalBaseUrl({ VERCEL_ENV: "production" }, ATTACKER),
    ).toThrowError(/No canonical app URL is configured/);
  });

  it("uses the request origin only in local development", () => {
    expect(canonicalBaseUrl({}, "http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });

  it("throws rather than guessing when nothing is configured and there is no origin", () => {
    expect(() => canonicalBaseUrl({})).toThrowError(/No canonical app URL/);
    expect(() => canonicalBaseUrl({}, "   ")).toThrowError(
      /No canonical app URL/,
    );
  });

  it("normalises a bare host and a trailing slash", () => {
    expect(canonicalBaseUrl({ APP_CANONICAL_URL: "app.example.com/" })).toBe(
      "https://app.example.com",
    );
    expect(
      canonicalBaseUrl({ APP_CANONICAL_URL: "  http://app.example.com//  " }),
    ).toBe("http://app.example.com");
    expect(canonicalBaseUrl({}, "http://localhost:3000/")).toBe(
      "http://localhost:3000",
    );
  });

  it("treats a blank configured value as unset", () => {
    expect(
      canonicalBaseUrl({
        APP_CANONICAL_URL: "   ",
        VERCEL_URL: "real.vercel.app",
      }),
    ).toBe("https://real.vercel.app");
  });
});
