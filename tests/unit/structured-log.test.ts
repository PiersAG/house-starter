// @vitest-environment node
//
// Structured request logging (PiersAG/app-business-core#503; Matt Murphy #207,
// #319): one JSON line per event with a fixed level scale, the request id,
// route, status, duration, user and tenant — never a body or a header — written
// through ONE swappable "send the logs" step whose default is the app's own
// database (the durable error log's home). And the request id the browser gets
// is the one on the request's error row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOG_LEVELS,
  __resetLogForTests,
  consoleSink,
  durableSink,
  flushLogs,
  levelAtLeast,
  logEvent,
  logLine,
  minLevel,
  registerLogSink,
  selectSink,
  slowRequestCountSince,
  slowRequestMs,
  toRecord,
  type LogRecord,
} from "@/lib/observability/log";
import { __resetSinkForTests, sinkClient } from "@/lib/observability/error-log";
import { runWithRequest, noteRequestUser, currentRequest } from "@/lib/observability/request-context";
import { newRequestId, safeRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { withRequestLog } from "@/lib/observability/with-request-log";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  __resetSinkForTests();
  __resetLogForTests();
  process.env.DATABASE_URL = ":memory:";
  delete process.env.DATABASE_AUTH_TOKEN;
  delete process.env.LOG_SINK;
  delete process.env.LOG_LEVEL;
  delete process.env.SLOW_REQUEST_MS;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL };
  __resetSinkForTests();
  __resetLogForTests();
});

describe("the level scale", () => {
  it("is fixed: debug < info < warn < error", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
    expect(levelAtLeast("warn", "info")).toBe(true);
    expect(levelAtLeast("debug", "info")).toBe(false);
  });

  it("LOG_LEVEL sets the lowest level written; anything else means info", () => {
    expect(minLevel({ LOG_LEVEL: "warn" } as unknown as NodeJS.ProcessEnv)).toBe("warn");
    expect(minLevel({ LOG_LEVEL: "loud" } as unknown as NodeJS.ProcessEnv)).toBe("info");
    expect(minLevel({} as unknown as NodeJS.ProcessEnv)).toBe("info");
  });

  it("drops an event below the lowest level", () => {
    logEvent({ level: "debug", event: "noise" });
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe("one line per event", () => {
  it("carries timestamp, level, request id, user, tenant, route, action and duration", () => {
    const rec = runWithRequest({ requestId: "req-12345678", route: "/api/x", method: "POST" }, () => {
      noteRequestUser("user-1", "tenant-1");
      return toRecord(
        { level: "info", event: "request", status: 201, durationMs: 12.6, action: "settings.update" },
        new Date("2026-11-02T10:00:00Z"),
      );
    });
    expect(rec).toEqual({
      at: "2026-11-02T10:00:00.000Z",
      level: "info",
      event: "request",
      request_id: "req-12345678",
      route: "/api/x",
      method: "POST",
      status: 201,
      duration_ms: 13,
      user_id: "user-1",
      tenant_id: "tenant-1",
      action: "settings.update",
      fields: {},
    });
    expect(JSON.parse(logLine(rec))).toMatchObject({ log_event: "request", request_id: "req-12345678" });
  });

  it("never carries a body, a header set or a secret-named field", () => {
    const rec = toRecord({
      level: "info",
      event: "x",
      fields: {
        body: { password: "pw" } as unknown as string,
        headers: new Headers({ cookie: "a=b" }) as unknown as string,
        accessToken: "abc",
        apiKey: "k",
        password: "pw",
        count: 3,
        ok: true,
        note: "n".repeat(900),
      },
    });
    expect(rec.fields).toEqual({ count: 3, ok: true, note: "n".repeat(500) });
  });

  it("writes errors to stderr, warnings to warn, the rest to stdout", () => {
    logEvent({ level: "error", event: "e" });
    logEvent({ level: "warn", event: "w" });
    logEvent({ level: "info", event: "i" });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledTimes(1);
  });
});

describe("the swappable send-the-logs step", () => {
  it("defaults to the durable sink, and an unknown name never means nothing", () => {
    expect(selectSink({} as unknown as NodeJS.ProcessEnv)).toBe(durableSink);
    expect(selectSink({ LOG_SINK: "nope" } as unknown as NodeJS.ProcessEnv)).toBe(durableSink);
    expect(selectSink({ LOG_SINK: "console" } as unknown as NodeJS.ProcessEnv)).toBe(consoleSink);
  });

  it("the durable sink writes the record to the app's own database", async () => {
    runWithRequest({ requestId: "req-abcdefgh", route: "/api/y", method: "GET" }, () =>
      logEvent({ level: "warn", event: "request", status: 200, durationMs: 1500, fields: { slow: true } }),
    );
    await flushLogs();
    const res = await sinkClient()!.execute(
      "SELECT level, event, request_id, route, status, duration_ms, fields FROM log_events",
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      level: "warn",
      event: "request",
      request_id: "req-abcdefgh",
      route: "/api/y",
      status: 200,
      duration_ms: 1500,
    });
    expect(JSON.parse(String(res.rows[0].fields))).toEqual({ slow: true });
    expect(await slowRequestCountSince(Date.now() - 60_000, 1000)).toBe(1);
    expect(await slowRequestCountSince(Date.now() - 60_000, 2000)).toBe(0);
  });

  it("an outside service plugs in as one more sink, chosen by LOG_SINK", async () => {
    const got: LogRecord[] = [];
    registerLogSink({ name: "tracker", send: async (r) => void got.push(r) });
    process.env.LOG_SINK = "tracker";
    logEvent({ level: "error", event: "boom" });
    await flushLogs();
    expect(got.map((r) => r.event)).toEqual(["boom"]);
  });

  it("a failing sink never throws into the caller", async () => {
    registerLogSink({ name: "broken", send: async () => Promise.reject(new Error("down")) });
    process.env.LOG_SINK = "broken";
    expect(() => logEvent({ level: "info", event: "x" })).not.toThrow();
    await flushLogs();
    expect(console.error).toHaveBeenCalledWith(
      "[log] the log sink could not write a record",
      "down",
    );
  });

  it("the console sink writes only the platform line", async () => {
    process.env.LOG_SINK = "console";
    logEvent({ level: "info", event: "x" });
    await flushLogs();
    await consoleSink.send({} as LogRecord);
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it("with no database the durable sink is a no-op and the count is 0", async () => {
    delete process.env.DATABASE_URL;
    __resetSinkForTests();
    await durableSink.send(toRecord({ level: "info", event: "x" }));
    expect(await slowRequestCountSince(0, 1)).toBe(0);
  });
});

describe("request ids", () => {
  it("are fresh UUIDs, and only a well-formed id is read back", () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(safeRequestId(new Headers({ [REQUEST_ID_HEADER]: id }))).toBe(id);
    expect(safeRequestId(new Headers({ [REQUEST_ID_HEADER]: "<script>" }))).toBeNull();
    expect(safeRequestId(new Headers())).toBeNull();
    expect(safeRequestId(null)).toBeNull();
  });

  it("outside a request there is no context", () => {
    expect(currentRequest()).toBeNull();
    noteRequestUser("u", "t"); // no-op, no throw
  });
});

describe("withRequestLog", () => {
  it("returns the request id the middleware set, and logs one line with status and duration", async () => {
    const id = newRequestId();
    const GET = withRequestLog("/api/z", async () => Response.json({ ok: true }, { status: 201 }));
    const res = await GET(new Request("http://x/api/z", { headers: { [REQUEST_ID_HEADER]: id } }));
    expect(res.status).toBe(201);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(id);
    const line = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(line).toMatchObject({ event: "request", request_id: id, route: "/api/z", method: "GET", status: 201 });
    expect(typeof line.duration_ms).toBe("number");
  });

  it("makes a fresh id when the request carries none, or a malformed one", async () => {
    const GET = withRequestLog("/api/z", async () => new Response("ok"));
    const res = await GET(new Request("http://x/api/z", { headers: { [REQUEST_ID_HEADER]: "bad id!" } }));
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a thrown error: fixed message with the id as reference, and the error row carries the same id", async () => {
    const POST = withRequestLog("/api/fail", async () => {
      throw new Error("SQLITE_CANTOPEN: /var/db/secret.db");
    });
    const res = await POST(new Request("http://x/api/fail", { method: "POST" }));
    const id = res.headers.get(REQUEST_ID_HEADER);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Something went wrong. Please try again.", reference: id });
    expect(JSON.stringify(body)).not.toContain("SQLITE");
    const row = await sinkClient()!.execute("SELECT request_id, level, route FROM error_events");
    expect(row.rows[0]).toMatchObject({ request_id: id, level: "error", route: "/api/fail" });
  });

  it("a slow handler is logged at warn and shows in the slow-request count", async () => {
    process.env.SLOW_REQUEST_MS = "1";
    expect(slowRequestMs()).toBe(1);
    const GET = withRequestLog("/api/slow", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return new Response("ok");
    });
    await GET(new Request("http://x/api/slow"));
    await flushLogs();
    expect(console.warn).toHaveBeenCalled();
    expect(await slowRequestCountSince(Date.now() - 60_000, 1)).toBe(1);
  });

  it("copies an immutable response so it can still carry the id", async () => {
    const GET = withRequestLog("/api/r", async () => Response.redirect("http://x/elsewhere", 302));
    const res = await GET(new Request("http://x/api/r"));
    expect(res.status).toBe(302);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("SLOW_REQUEST_MS defaults to 1000", () => {
    expect(slowRequestMs({} as unknown as NodeJS.ProcessEnv)).toBe(1000);
  });
});
