// @vitest-environment node
//
// Sending to Sentry (app-business-core issues 761 and 806): the exact event,
// the envelope, the free-plan limits, the second destination for error-level
// logs and the distinct cross-customer access alert. The switch is turned on
// for this file only (the module copy is per test file); the posture-aware
// both-states proof is tests/unit/error-tracking-both-states.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorTrackingConfig, type ErrorTrackingConfig } from "@/config/error-tracking";
import {
  SendGate,
  __resetErrorTrackingForTests,
  __setErrorTrackingTransportForTests,
  buildEvent,
  envelopeFor,
  flushErrorTracking,
  reportBrowserError,
  reportCrossTenantAccess,
  reportException,
  reportLogRecord,
  sendReport,
  type SentryEvent,
} from "@/lib/observability/sentry";
import { runWithRequest, noteRequestUser } from "@/lib/observability/request-context";
import type { LogRecord } from "@/lib/observability/log";
import { resetRateLimiterForTests } from "@/lib/rate-limit";

const KEY = "0123456789abcdef0123456789abcdef";
const DSN = `https://${KEY}@o42.ingest.de.sentry.io/7`;
const ENV = { SENTRY_DSN: DSN, VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "abc1234def" } as unknown as NodeJS.ProcessEnv;
const ORIGINAL = { ...process.env };
const ORIGINAL_ENABLED = errorTrackingConfig.enabled;

type Call = { url: string; init: RequestInit };
let calls: Call[];
let status: number;

function events(): SentryEvent[] {
  return calls.map((c) => JSON.parse(String(c.init.body).trim().split("\n")[2]) as SentryEvent);
}

beforeEach(() => {
  errorTrackingConfig.enabled = true;
  process.env.RATE_LIMIT_ALLOW_IN_MEMORY = "true";
  delete process.env.RATE_LIMIT_STORE_URL;
  delete process.env.VERCEL_ENV;
  resetRateLimiterForTests();
  __resetErrorTrackingForTests(errorTrackingConfig, () => 0.99);
  calls = [];
  status = 200;
  __setErrorTrackingTransportForTests(async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status, headers: status === 429 ? { "retry-after": "120" } : {} });
  });
});

afterEach(() => {
  errorTrackingConfig.enabled = ORIGINAL_ENABLED;
  __setErrorTrackingTransportForTests(null);
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("the event — only the error's type, place and safe context", () => {
  it("has no request, extra or breadcrumbs part, and the user is an opaque id only", () => {
    const e = buildEvent(
      {
        source: "server",
        type: "TypeError",
        message: "no row for jane@example.com",
        stack: "TypeError: x\n    at f (/srv/a.js:1:2)",
        route: "/dashboard/clients/123456?x=1",
        method: "post",
        requestId: "req-12345678",
        userId: "user-abc",
      },
      ENV,
      new Date("2026-11-05T00:00:00Z"),
    );
    expect(Object.keys(e).sort()).toEqual(
      ["contexts", "environment", "event_id", "exception", "level", "logger", "platform", "release", "sdk", "tags", "timestamp", "user"].sort(),
    );
    expect(e.user).toEqual({ id: "user-abc" });
    expect(e.exception?.values[0]).toMatchObject({ type: "TypeError", value: "no row for [email]" });
    expect(e.tags).toEqual({ source: "server", route: "/dashboard/clients/:id", method: "POST", request_id: "req-12345678" });
    expect(e.release).toBe("abc1234def");
    expect(e.environment).toBe("production");
    expect(JSON.stringify(e)).not.toMatch(/jane|cookie|ip_address|headers|"request"/);
  });

  it("drops a user id that is an email address", () => {
    expect(buildEvent({ source: "log", message: "m", userId: "jane@example.com" }, ENV).user).toBeUndefined();
  });

  it("is sent as one envelope to the EU address with the public key", async () => {
    expect(reportException({ message: "boom", stack: "Error: boom\n    at f (/a.js:1:1)" }, ENV)).toBe(true);
    await flushErrorTracking();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://o42.ingest.de.sentry.io/api/7/envelope/");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-sentry-auth"]).toContain(`sentry_key=${KEY}`);
    expect(headers["content-type"]).toBe("application/x-sentry-envelope");
    const lines = String(calls[0].init.body).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toEqual({ type: "event", content_type: "application/json" });
    expect(JSON.parse(lines[0]).event_id).toBe(JSON.parse(lines[2]).event_id);
  });

  it("envelopeFor writes header, item header and event, one per line", () => {
    const e = buildEvent({ source: "log", message: "m" }, ENV);
    expect(envelopeFor(e).split("\n")).toHaveLength(4);
  });

  it("attaches the signed-in account from the request, so Sentry counts the accounts an error reached", async () => {
    await runWithRequest({ requestId: "req-abcdef12", route: "/api/tenant", method: "GET" }, async () => {
      noteRequestUser("user-1", "tenant-1");
      reportException({ message: "boom", stack: "RangeError: boom" }, ENV);
    });
    await flushErrorTracking();
    expect(events()[0]).toMatchObject({ user: { id: "user-1" }, tags: { route: "/api/tenant", request_id: "req-abcdef12" } });
    expect(events()[0].exception?.values[0].type).toBe("RangeError");
  });
});

describe("nothing is sent while the switch is off or no EU key is set", () => {
  it("off", async () => {
    errorTrackingConfig.enabled = false;
    expect(reportException({ message: "boom" }, ENV)).toBe(false);
    expect(reportCrossTenantAccess({ userId: "u", sessionTenantId: "a", dataTenantId: "b" }, ENV)).toBe(false);
    await flushErrorTracking();
    expect(calls).toEqual([]);
  });
  it("on, with no key or a US key", async () => {
    expect(reportException({ message: "boom" }, {} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(reportException({ message: "boom" }, { SENTRY_DSN: `https://${KEY}@o42.ingest.us.sentry.io/7` } as unknown as NodeJS.ProcessEnv)).toBe(false);
    await flushErrorTracking();
    expect(calls).toEqual([]);
  });
});

describe("error-level log lines — the second destination", () => {
  const record = (over: Partial<LogRecord>): LogRecord => ({
    at: "2026-11-05T00:00:00.000Z",
    level: "error",
    event: "signup.provision_failed",
    request_id: "req-12345678",
    route: "/signup",
    method: "POST",
    status: null,
    duration_ms: null,
    user_id: "user-9",
    tenant_id: "tenant-9",
    action: null,
    fields: { account: "deleted", email: "jane@example.com", attempts: 2 },
    ...over,
  });

  it("goes as a message event grouped by its event name, with only safe fields", async () => {
    expect(reportLogRecord(record({}), ENV)).toBe(true);
    await flushErrorTracking();
    const e = events()[0];
    expect(e.message).toEqual({ formatted: "signup.provision_failed" });
    expect(e.fingerprint).toEqual(["log", "signup.provision_failed"]);
    expect(e.tags).toMatchObject({ source: "log", event: "signup.provision_failed", account: "deleted", attempts: "2" });
    expect(JSON.stringify(e)).not.toContain("jane");
    expect(e.user).toEqual({ id: "user-9" });
  });

  it("is not sent below error level, for a request line, or for the cross-customer event", () => {
    expect(reportLogRecord(record({ level: "warn" }), ENV)).toBe(false);
    expect(reportLogRecord(record({ event: "request", status: 500 }), ENV)).toBe(false);
    expect(reportLogRecord(record({ event: "cross_tenant_access" }), ENV)).toBe(false);
  });
});

describe("the cross-customer access alert — distinct and high priority", () => {
  it("is level fatal, tagged for an alert rule, in one group, naming no customer data", async () => {
    expect(
      reportCrossTenantAccess(
        { userId: "user-a", sessionTenantId: "tenant-a", dataTenantId: "tenant-b", route: "/api/tenant", method: "GET", requestId: "req-12345678" },
        ENV,
      ),
    ).toBe(true);
    await flushErrorTracking();
    const e = events()[0];
    expect(e.level).toBe("fatal");
    expect(e.fingerprint).toEqual(["cross-tenant-access"]);
    expect(e.tags).toMatchObject({
      source: "cross_tenant",
      alert: "cross_tenant_access",
      priority: "high",
      data_tenant: "tenant-b",
      session_tenant: "tenant-a",
    });
    expect(e.user).toEqual({ id: "user-a" });
    expect(e.message?.formatted).toMatch(/^Cross-customer access/);
  });

  it("is never deduplicated or budgeted away, only capped per hour", async () => {
    const config: ErrorTrackingConfig = { ...errorTrackingConfig, maxEventsPerHour: 1, dailyBudget: 1, maxCrossTenantAlertsPerHour: 3 };
    __resetErrorTrackingForTests(config, () => 0.99);
    for (let i = 0; i < 5; i++) {
      sendReport({ source: "cross_tenant", message: "x", fingerprint: ["cross-tenant-access"] }, ENV, config);
    }
    await flushErrorTracking();
    expect(calls).toHaveLength(3);
  });
});

describe("browser errors relayed by /api/error-report", () => {
  it("carry the page path, the browser and the account, not the query", async () => {
    reportBrowserError(
      {
        type: "TypeError",
        message: "x is undefined",
        stack: "f@https://app.example.com/_next/static/chunks/a.js?v=1:1:2",
        page: "/dashboard/dogs/123456?q=jane",
        kind: "error",
        userId: "user-b",
        userAgent: "Mozilla/5.0 Chrome/130.0.1 Safari/537.36",
      },
      ENV,
    );
    await flushErrorTracking();
    const e = events()[0];
    expect(e.platform).toBe("javascript");
    expect(e.contexts).toEqual({ browser: { name: "Chrome", version: "130" } });
    expect(e.tags).toMatchObject({ source: "browser", route: "/dashboard/dogs/:id", kind: "error" });
    expect(e.exception?.values[0].stacktrace?.frames[0].filename).toBe("app:///_next/static/chunks/a.js");
    expect(JSON.stringify(e)).not.toContain("jane");
  });
});

describe("the free plan's limits", () => {
  const config = (over: Partial<ErrorTrackingConfig>): ErrorTrackingConfig => ({ ...errorTrackingConfig, ...over });

  it("sends a new error at once, then only a sample of its repeats inside the window", () => {
    const gate = new SendGate(config({ repeatSampleRate: 0.1 }), () => 0.5);
    expect(gate.allow("a", "normal", 0)).toBe(true);
    expect(gate.allow("a", "normal", 1000)).toBe(false);
    expect(gate.allow("b", "normal", 1000)).toBe(true);
    expect(gate.allow("a", "normal", 61 * 60_000)).toBe(true);
    const lucky = new SendGate(config({ repeatSampleRate: 0.1 }), () => 0.05);
    lucky.allow("a", "normal", 0);
    expect(lucky.allow("a", "normal", 1000)).toBe(true);
  });

  it("stops at the hourly cap and starts again the next hour", () => {
    const gate = new SendGate(config({ maxEventsPerHour: 2 }));
    expect([gate.allow("a", "normal", 0), gate.allow("b", "normal", 1), gate.allow("c", "normal", 2)]).toEqual([true, true, false]);
    expect(gate.allow("d", "normal", 3_600_001)).toBe(true);
  });

  it("stops at the day's budget shared by every instance", async () => {
    const c = config({ dailyBudget: 52, browserDailyBudget: 50 });
    __resetErrorTrackingForTests(c, () => 0.99);
    for (const m of ["one", "two", "three"]) sendReport({ source: "log", message: m }, ENV, c);
    await flushErrorTracking();
    expect(calls).toHaveLength(2);
  });

  it("gives browser reports their own share, so forged ones cannot crowd out server errors", async () => {
    const c = config({ dailyBudget: 3, browserDailyBudget: 1 });
    __resetErrorTrackingForTests(c, () => 0.99);
    for (const m of ["b1", "b2", "b3"]) sendReport({ source: "browser", type: "Error", message: m }, ENV, c);
    for (const m of ["s1", "s2"]) sendReport({ source: "server", type: "Error", message: m }, ENV, c);
    await flushErrorTracking();
    expect(events().map((e) => e.exception?.values[0].value).sort()).toEqual(["b1", "s1", "s2"]);
  });

  it("caps browser reports at half the hourly limit, counted apart from the server's", () => {
    const gate = new SendGate(config({ maxEventsPerHour: 4 }));
    expect(["a", "b", "c"].map((k) => gate.allow(k, "browser", 0))).toEqual([true, true, false]);
    expect(["d", "e", "f", "g", "h"].map((k) => gate.allow(k, "normal", 0))).toEqual([true, true, true, true, false]);
  });

  it("pauses when Sentry answers 429 (over quota)", async () => {
    status = 429;
    reportException({ message: "first" }, ENV);
    await flushErrorTracking();
    expect(reportException({ message: "second" }, ENV)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("never throws when Sentry cannot be reached", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    __setErrorTrackingTransportForTests(async () => {
      throw new Error("network down");
    });
    expect(reportException({ message: "boom" }, ENV)).toBe(true);
    await expect(flushErrorTracking()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe("server stack frames name the original file and line", () => {
  it("maps a frame through the build's source map, and leaves an unmapped one alone", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { createRequire } = await import("node:module");
    const { originalStack } = await import("@/lib/observability/sentry");
    process.setSourceMapsEnabled(true);
    const dir = mkdtempSync(join(tmpdir(), "hs-at-map-"));
    const file = join(dir, "page.js");
    // Generated line 1, column 0 → webpack://app/lib/orig.ts line 10, column 0.
    const map = { version: 3, file: "page.js", sources: ["webpack://app/lib/orig.ts"], names: [], mappings: "AASA" };
    writeFileSync(
      file,
      `module.exports = function boom() { throw new Error("x"); };\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`,
    );
    createRequire(import.meta.url)(file);
    const mapped = originalStack(`Error: x\n    at boom (${file}:1:41)\n    at other (/nowhere/x.js:3:4)`);
    expect(mapped).toBe("Error: x\n    at boom (/lib/orig.ts:10:41)\n    at other (/nowhere/x.js:3:4)");
    expect(originalStack(null)).toBeNull();
  });
});

describe("the request id", () => {
  it("is kept as it is (a UUID), so the same request is found in the app's own logs", () => {
    const id = "3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    expect(buildEvent({ source: "server", message: "m", requestId: id }, ENV).tags.request_id).toBe(id);
    expect(buildEvent({ source: "server", message: "m", requestId: "bad id!" }, ENV).tags.request_id).toBeUndefined();
  });
});

describe("a forged browser report", () => {
  it("cannot set an error type that is not an identifier", async () => {
    reportBrowserError({ type: "Jane Doe <jane@example.com>", message: "m", page: "/", kind: "error" }, ENV);
    await flushErrorTracking();
    expect(events()[0].exception?.values[0].type).toBe("Error");
  });
});

describe("a rage click (issue 736)", () => {
  it("is a warning grouped by page and control, not an exception", async () => {
    reportBrowserError(
      { type: "RageClick", message: "Rage click on button#save", page: "/dashboard/x/123456?q=1", kind: "rage_click", userId: "user-c", userAgent: null },
      ENV,
    );
    await flushErrorTracking();
    const e = events()[0];
    expect(e.level).toBe("warning");
    expect(e.exception).toBeUndefined();
    expect(e.message).toEqual({ formatted: "Rage click on button#save" });
    expect(e.fingerprint).toEqual(["rage-click", "/dashboard/x/:id", "Rage click on button#save"]);
  });
});
