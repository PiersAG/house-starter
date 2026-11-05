// @vitest-environment node
//
// Only Sentry's EU address is used (decision 700, settled 2026-11-02: "in its
// EU data region"; app-business-core issue 761), and only a DSN with no secret
// part. Anything else counts as "no key set": nothing is sent.

import { describe, expect, it } from "vitest";
import { errorTrackingStatus, errorTrackingTarget, parseSentryDsn } from "@/lib/observability/sentry-dsn";
import { SENTRY_FREE_PLAN_ERRORS_PER_MONTH, errorTrackingConfig } from "@/config/error-tracking";

const KEY = "0123456789abcdef0123456789abcdef";
const EU = `https://${KEY}@o4508000000000001.ingest.de.sentry.io/4508000000000002`;
const ON = { enabled: true };
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const OFF = { enabled: false };

describe("parseSentryDsn", () => {
  it("reads an EU DSN into its envelope address", () => {
    expect(parseSentryDsn(EU)).toEqual({
      origin: "https://o4508000000000001.ingest.de.sentry.io",
      host: "o4508000000000001.ingest.de.sentry.io",
      publicKey: KEY,
      projectId: "4508000000000002",
      envelopeUrl: "https://o4508000000000001.ingest.de.sentry.io/api/4508000000000002/envelope/",
    });
  });

  it.each([
    ["the US region", `https://${KEY}@o1.ingest.us.sentry.io/2`],
    ["the old default region", `https://${KEY}@o1.ingest.sentry.io/2`],
    ["a self-hosted server", `https://${KEY}@sentry.example.com/2`],
    ["a look-alike host", `https://${KEY}@o1.ingest.de.sentry.io.evil.example/2`],
    ["plain http", `http://${KEY}@o1.ingest.de.sentry.io/2`],
    ["a secret key part", `https://${KEY}:${KEY}@o1.ingest.de.sentry.io/2`],
    ["a port", `https://${KEY}@o1.ingest.de.sentry.io:8443/2`],
    ["a deeper path", `https://${KEY}@o1.ingest.de.sentry.io/x/2`],
    ["a query", `https://${KEY}@o1.ingest.de.sentry.io/2?a=1`],
    ["a short key", "https://abc@o1.ingest.de.sentry.io/2"],
    ["no key", "https://o1.ingest.de.sentry.io/2"],
    ["not a URL", "not a dsn"],
    ["nothing", ""],
  ])("refuses %s", (_label, dsn) => {
    expect(parseSentryDsn(dsn)).toBeNull();
  });
});

describe("errorTrackingTarget — the switch and the key together", () => {
  it("is null when the switch is off, whatever the DSN", () => {
    expect(errorTrackingTarget(env({ SENTRY_DSN: EU }), OFF)).toBeNull();
  });
  it("is null when the switch is on and no DSN, or a non-EU one, is set", () => {
    expect(errorTrackingTarget(env({}), ON)).toBeNull();
    expect(errorTrackingTarget(env({ SENTRY_DSN: `https://${KEY}@o1.ingest.us.sentry.io/2` }), ON)).toBeNull();
  });
  it("is the EU target when the switch is on and the DSN is an EU one", () => {
    expect(errorTrackingTarget(env({ SENTRY_DSN: EU }), ON)?.host).toBe("o4508000000000001.ingest.de.sentry.io");
  });
});

describe("errorTrackingStatus — the health check's reading", () => {
  it("says nothing while the switch is off", () => {
    expect(errorTrackingStatus(env({ SENTRY_DSN: EU }), OFF)).toEqual({ on: false });
  });
  it("is not ok, with a plain reason, when on without a usable key", () => {
    expect(errorTrackingStatus(env({}), ON)).toMatchObject({ on: true, ok: false, detail: expect.stringContaining("not set") });
    expect(errorTrackingStatus(env({ SENTRY_DSN: "https://x@sentry.example.com/1" }), ON)).toMatchObject({
      on: true,
      ok: false,
      detail: expect.stringContaining("EU"),
    });
  });
  it("is ok when on and connected", () => {
    expect(errorTrackingStatus(env({ SENTRY_DSN: EU }), ON)).toEqual({ on: true, ok: true, detail: "errors are sent to Sentry (EU)" });
  });
});

describe("config/error-tracking.ts keeps within the free plan", () => {
  const c = errorTrackingConfig;
  it("the day's budget over a 31-day month leaves room under 5,000 for the cross-customer alerts", () => {
    expect(c.dailyBudget * 31).toBeLessThanOrEqual(SENTRY_FREE_PLAN_ERRORS_PER_MONTH - 300);
  });
  it("one instance cannot spend the whole day's budget in under an hour", () => {
    expect(c.maxEventsPerHour).toBeLessThan(c.dailyBudget);
    expect(c.maxEventsPerHour).toBeGreaterThan(0);
  });
  it("repeats are sampled, never all sent and never all dropped", () => {
    expect(c.repeatSampleRate).toBeGreaterThan(0);
    expect(c.repeatSampleRate).toBeLessThan(1);
    expect(c.dedupeWindowMinutes).toBeGreaterThanOrEqual(10);
  });
  it("a page sends only a few reports", () => {
    expect(c.browserMaxReportsPerPage).toBeGreaterThan(0);
    expect(c.browserMaxReportsPerPage).toBeLessThanOrEqual(10);
  });
});
