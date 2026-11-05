// @vitest-environment node
//
// Error tracking in BOTH states (app-business-core issue 761; capability model:
// every switch tested in both states, OFF enforced at the route). This suite
// reads the committed switch (config/error-tracking.ts) and asserts the
// matching behaviour; CI runs it with the switch flipped each way
// (ci.yml error-tracking-matrix), so the off leg fails if anything is sent and
// the on leg fails if nothing is.
//
//   OFF: nothing reaches Sentry — not an exception, not an error log line, not
//        the cross-customer alert; /api/error-report is 404; the server may
//        not connect to Sentry; the health check says nothing; Sentry is "not
//        connected yet" on the subprocessor list.
//   ON:  each of those reaches Sentry's EU address once; the report route
//        takes a browser error; Sentry's host is allowed out; the health
//        check is ok; Sentry is "in use".
//   BOTH: the page policy never names Sentry (browser errors go through the
//        app's own route), and with no key set nothing is sent.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: { user: { id: "user-signed-in" } } as null | { user: { id: string } } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));

import { errorTrackingConfig } from "@/config/error-tracking";
import { SUBPROCESSORS } from "@/config/subprocessors";
import { POST as errorReportPOST } from "@/app/api/error-report/route";
import { __resetErrorTrackingForTests, __setErrorTrackingTransportForTests, flushErrorTracking } from "@/lib/observability/sentry";
import { __resetSinkForTests, recordError } from "@/lib/observability/error-log";
import { __resetLogForTests, flushLogs, logEvent } from "@/lib/observability/log";
import { runWithRequest } from "@/lib/observability/request-context";
import { noteTenantAccess } from "@/lib/tenant/access-log";
import { allowList, isAllowed } from "@/lib/egress";
import { assembleHealth } from "@/lib/health/checks";
import { errorTrackingStatus } from "@/lib/observability/sentry-dsn";
import { cspHeaders } from "@/lib/csp";
import { resetRateLimiterForTests } from "@/lib/rate-limit";
import type { AppDatabase } from "@/lib/users";

const ON = errorTrackingConfig.enabled;
const HOST = "o42.ingest.de.sentry.io";
const DSN = `https://0123456789abcdef0123456789abcdef@${HOST}/7`;
const ORIGINAL = { ...process.env };
let sent: { url: string; body: string }[];

beforeEach(() => {
  process.env.SENTRY_DSN = DSN;
  process.env.DATABASE_URL = ":memory:";
  process.env.RATE_LIMIT_ALLOW_IN_MEMORY = "true";
  delete process.env.RATE_LIMIT_STORE_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.LOG_SINK;
  resetRateLimiterForTests();
  __resetSinkForTests();
  __resetLogForTests();
  __resetErrorTrackingForTests();
  sent = [];
  __setErrorTrackingTransportForTests(async (url, init) => {
    sent.push({ url, body: String(init.body) });
    return new Response(null, { status: 200 });
  });
});

afterAll(() => {
  __setErrorTrackingTransportForTests(null);
  process.env = { ...ORIGINAL };
});

const expected = ON ? 1 : 0;
const describeState = `error tracking ${ON ? "ON" : "OFF"} (config/error-tracking.ts)`;

describe(describeState, () => {
  it(`an exception the error log records: ${expected} event to Sentry`, async () => {
    await recordError({ message: "boom", stack: "Error: boom\n    at f (/a.js:1:1)", route: "/x", method: "GET" });
    await flushErrorTracking();
    expect(sent).toHaveLength(expected);
    if (ON) expect(sent[0].url).toBe(`https://${HOST}/api/7/envelope/`);
  });

  it(`an error-level log line: ${expected} event to Sentry, and the log's own sink kept`, async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logEvent({ level: "error", event: "billing.sync_failed", fields: { attempts: 2 } });
    await flushLogs();
    await flushErrorTracking();
    expect(sent).toHaveLength(expected);
    expect(log.mock.calls.some((c) => String(c[0]).includes('"log_event":"billing.sync_failed"'))).toBe(true);
    log.mockRestore();
  });

  it(`a cross-customer access: ${expected} distinct alert event (and no second, plain one)`, async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fakeCatalog = { insert: () => ({ values: () => ({ run: async () => undefined }) }) } as unknown as AppDatabase;
    await runWithRequest({ requestId: "req-12345678", route: "/api/tenant", method: "GET" }, () =>
      noteTenantAccess("tenant-b", { db: fakeCatalog, caller: { userId: "user-a", tenantId: "tenant-a" } }),
    );
    await flushLogs();
    await flushErrorTracking();
    expect(sent).toHaveLength(expected);
    if (ON) {
      const event = JSON.parse(sent[0].body.trim().split("\n")[2]);
      expect(event.level).toBe("fatal");
      expect(event.tags.alert).toBe("cross_tenant_access");
    }
    err.mockRestore();
  });

  it(ON ? "/api/error-report takes a same-origin browser error and sends it on" : "/api/error-report is 404", async () => {
    const res = await errorReportPOST(
      new Request("https://app.example.com/api/error-report", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.com", "user-agent": "Mozilla/5.0 Firefox/132.0" },
        body: JSON.stringify({ type: "TypeError", message: "x is undefined", stack: null, page: "/dashboard", kind: "error" }),
      }),
    );
    await flushErrorTracking();
    expect(res.status).toBe(ON ? 204 : 404);
    expect(sent).toHaveLength(expected);
    if (ON) {
      const event = JSON.parse(sent[0].body.trim().split("\n")[2]);
      expect(event.user).toEqual({ id: "user-signed-in" });
      expect(event.contexts.browser.name).toBe("Firefox");
    }
  });

  it(`the server ${ON ? "may" : "may not"} connect to Sentry`, () => {
    expect(isAllowed(HOST, allowList(process.env))).toBe(ON);
  });

  it(`the health check ${ON ? "shows error tracking connected" : "says nothing"}`, async () => {
    const report = await assembleHealth({
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => 0,
      errorTracking: () => errorTrackingStatus(),
      now: () => 0,
      env: process.env,
    });
    const check = report.checks.find((c) => c.name === "error_tracking");
    if (ON) expect(check).toEqual({ name: "error_tracking", ok: true, critical: false, detail: "errors are sent to Sentry (EU)" });
    else expect(check).toBeUndefined();
  });

  it(`Sentry is "${ON ? "in_use" : "chosen_not_connected"}" on the subprocessor list`, () => {
    expect(SUBPROCESSORS.find((s) => s.id === "sentry")?.status).toBe(ON ? "in_use" : "chosen_not_connected");
  });
});

describe("in both states", () => {
  it("the page policy never names Sentry", () => {
    expect(JSON.stringify(cspHeaders("nonce"))).not.toMatch(/sentry/i);
  });

  it("with no key set, nothing is sent, the route is 404, and the app keeps working", async () => {
    delete process.env.SENTRY_DSN;
    await recordError({ message: "boom" });
    logEvent({ level: "error", event: "x.failed" });
    await flushLogs();
    await flushErrorTracking();
    expect(sent).toEqual([]);
    const res = await errorReportPOST(
      new Request("https://app.example.com/api/error-report", {
        method: "POST",
        headers: { origin: "https://app.example.com" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);
    expect(isAllowed(HOST, allowList(process.env))).toBe(false);
  });

  it("with a non-EU key set, nothing is sent", async () => {
    process.env.SENTRY_DSN = "https://0123456789abcdef0123456789abcdef@o42.ingest.us.sentry.io/7";
    await recordError({ message: "boom" });
    await flushErrorTracking();
    expect(sent).toEqual([]);
  });
});

if (ON) {
  describe("the report route, switched on, is bounded", () => {
    const post = (headers: Record<string, string>, body: string) =>
      errorReportPOST(new Request("https://app.example.com/api/error-report", { method: "POST", headers, body }));

    it("refuses another site's request", async () => {
      const res = await post({ origin: "https://evil.example" }, JSON.stringify({ type: "E", message: "m", page: "/", kind: "error" }));
      expect(res.status).toBe(403);
      expect(sent).toEqual([]);
    });

    it("drops a body over 16 KB, a body that is not the fixed shape, and extra fields", async () => {
      const ok = { type: "E", message: "m", page: "/", kind: "error" };
      for (const body of [
        JSON.stringify({ ...ok, message: "m".repeat(20_000) }),
        "not json",
        JSON.stringify({ ...ok, cookie: "sid=1" }),
        JSON.stringify({ ...ok, kind: "other" }),
      ]) {
        expect((await post({ origin: "https://app.example.com" }, body)).status).toBe(204);
      }
      await flushErrorTracking();
      expect(sent).toEqual([]);
    });

    it("sends a signed-out visitor's error with no account", async () => {
      session.value = null;
      await post({ origin: "https://app.example.com" }, JSON.stringify({ type: "E", message: "m", page: "/", kind: "error" }));
      await flushErrorTracking();
      expect(JSON.parse(sent[0].body.trim().split("\n")[2]).user).toBeUndefined();
      session.value = { user: { id: "user-signed-in" } };
    });
  });
}

describe("readable server stacks follow the switch", () => {
  it(`next.config.ts keeps server source maps ${ON ? "on" : "off"}`, async () => {
    const { default: nextConfig } = await import("../../next.config");
    expect(nextConfig.experimental?.serverSourceMaps).toBe(ON);
  });
});
