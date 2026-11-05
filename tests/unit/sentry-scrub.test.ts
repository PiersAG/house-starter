// @vitest-environment node
//
// What reaches Sentry is stripped of personal data first (app-business-core
// issue 761; the Dispatch AT brief: "no emails, names, cookies, request bodies
// or customer data, only error type, place and safe context"). One test per
// rule in lib/observability/sentry-scrub.ts.

import { describe, expect, it } from "vitest";
import {
  browserOf,
  opaqueId,
  parseStack,
  safeLogFields,
  scrubPath,
  scrubText,
} from "@/lib/observability/sentry-scrub";

describe("scrubText", () => {
  it("removes email addresses", () => {
    expect(scrubText("no account for jane.doe+test@example.co.uk here")).toBe("no account for [email] here");
  });

  it("removes bearer and basic credentials, JWTs and secret=value pairs", () => {
    expect(scrubText("Authorization: Bearer abc.def-123")).not.toContain("abc.def-123");
    expect(scrubText("got Basic dXNlcjpwYXNz")).toBe("got Basic [redacted]");
    expect(scrubText("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part")).toBe("token [token]");
    expect(scrubText("password=hunter2 secret: 'x y z' api_key=k1")).toBe(
      "password=[redacted] secret: [redacted] api_key=[redacted]",
    );
    expect(scrubText("cookie=sid123; session_id=abc")).not.toMatch(/sid123|abc$/);
  });

  it("removes a database error's parameter list", () => {
    const drizzle = 'Failed query: insert into "users" ("email","name") values (?, ?)\nparams: jane@example.com,Jane Doe';
    const out = scrubText(drizzle);
    expect(out).toContain("Failed query: insert into");
    expect(out).toContain("params: [redacted]");
    expect(out).not.toContain("Jane");
  });

  it("removes UUIDs, IP addresses, long tokens and phone or card numbers", () => {
    expect(scrubText("tenant 3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f gone")).toBe("tenant [id] gone");
    expect(scrubText("from 203.0.113.7 and 2001:db8:85a3:0:0:8a2e:370:7334")).toBe("from [ip] and [ip]");
    expect(scrubText("from fe80::1 too")).toBe("from [ip] too");
    expect(scrubText("key sk_test_51HxYz9AbCdEfGhIjKlMnOpQr")).toBe("key [redacted]");
    expect(scrubText("call 07700 900123 or +44 7700 900 123")).toBe("call [number] or [number]");
    expect(scrubText("card 4242 4242 4242 4242")).toBe("card [number]");
  });

  it("keeps what is needed to fix the fault: times, dates, short numbers and code words", () => {
    expect(scrubText("timeout at 10:30:45 on 2026-11-05 after 3000 ms")).toBe(
      "timeout at 10:30:45 on 2026-11-05 after 3000 ms",
    );
    expect(scrubText("Cannot read properties of undefined (reading 'tenantId')")).toBe(
      "Cannot read properties of undefined (reading 'tenantId')",
    );
    expect(scrubText("Unexpected token < in JSON at position 0")).toBe("Unexpected token < in JSON at position 0");
  });

  it("removes quoted values, keeping quoted code names", () => {
    expect(scrubText('Invalid name "Jane Doe" for dog "Rex 2024"')).toBe('Invalid name "[value]" for dog "[value]"');
    expect(scrubText("value 'a@b' refused")).toBe("value '[value]' refused");
    expect(scrubText('{"received":"Jane"}')).toBe('{"received":"[value]"}');
    expect(scrubText("no column 'users.email' in 'lib/db', code 'SQLITE_ERROR', a 'TypeError'")).toBe(
      "no column 'users.email' in 'lib/db', code 'SQLITE_ERROR', a 'TypeError'",
    );
  });

  it("removes a URL's query string and fragment", () => {
    expect(scrubText("fetch https://api.example.com/v1/x?email=a%40b.com&t=1 failed")).toBe(
      "fetch https://api.example.com/v1/x?[query] failed",
    );
  });

  it("clips long text", () => {
    expect(scrubText("a".repeat(5000)).length).toBeLessThanOrEqual(1001);
  });
});

describe("scrubPath", () => {
  it("keeps the route's shape and drops the query, fragment and ids", () => {
    expect(scrubPath("/dashboard/clients/3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/edit?tab=notes#x")).toBe(
      "/dashboard/clients/:id/edit",
    );
    expect(scrubPath("https://app.example.com/invoices/123456?x=1")).toBe("/invoices/:id");
    expect(scrubPath("/reset-password/jane@example.com")).toBe("/reset-password/:id");
    expect(scrubPath("/u/jane%40example.com")).toBe("/u/:id");
    expect(scrubPath(null)).toBeNull();
  });
});

describe("parseStack", () => {
  it("reads V8 frames, oldest call first, with the app's own paths relative", () => {
    const stack = [
      "TypeError: boom",
      `    at inner (${process.cwd()}/.next/server/app/page.js:12:34)`,
      "    at async outer (node:internal/process/task_queues:95:5)",
      `    at ${process.cwd()}/node_modules/next/dist/server.js:1:2`,
    ].join("\n");
    const frames = parseStack(stack);
    expect(frames).toHaveLength(3);
    expect(frames[2]).toEqual({ function: "inner", filename: "app:///.next/server/app/page.js", lineno: 12, colno: 34, in_app: true });
    expect(frames[0].in_app).toBe(false);
    expect(frames[1].in_app).toBe(false);
  });

  it("reads Firefox and Safari frames and drops a script URL's query", () => {
    const frames = parseStack("handler@https://app.example.com/_next/static/chunks/app.js?dpl=abc:3:9\n@https://app.example.com/x.js:1:1");
    expect(frames.map((f) => f.filename)).toEqual(["app:///x.js", "app:///_next/static/chunks/app.js"]);
    expect(frames[1].lineno).toBe(3);
  });

  it("keeps at most 50 frames and nothing that is not a frame", () => {
    const stack = Array.from({ length: 80 }, (_, i) => `    at f${i} (/x.js:${i + 1}:1)`).join("\n");
    expect(parseStack(stack)).toHaveLength(50);
    expect(parseStack("just text\nmore text")).toEqual([]);
    expect(parseStack(null)).toEqual([]);
  });
});

describe("browserOf", () => {
  it("keeps the browser's name and major version only", () => {
    expect(browserOf("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36")).toEqual({ name: "Chrome", version: "130" });
    expect(browserOf("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15")).toEqual({ name: "Safari", version: "18" });
    expect(browserOf("Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0")).toEqual({ name: "Firefox", version: "132" });
    expect(browserOf("Mozilla/5.0 ... Chrome/130.0 Safari/537.36 Edg/130.0.1")).toEqual({ name: "Edge", version: "130" });
    expect(browserOf("curl/8.0")).toEqual({ name: "Other" });
    expect(browserOf("")).toBeNull();
  });
});

describe("safeLogFields", () => {
  it("passes numbers, booleans and short codes, and nothing named for personal data", () => {
    expect(
      safeLogFields({
        reason: "account-missing",
        attempts: 3,
        slow: true,
        email: "a@b.com",
        name: "Jane",
        ip: "203.0.113.7",
        note: "short",
        detail: "a sentence with spaces in it",
        target: "x@y",
        failedSteps: "database,account",
      }),
    ).toEqual({ reason: "account-missing", attempts: "3", slow: "true", failedSteps: "database,account" });
  });
});

describe("opaqueId", () => {
  it("accepts an opaque id and refuses an email used as one", () => {
    expect(opaqueId("user-3f2b8c1e")).toBe("user-3f2b8c1e");
    expect(opaqueId("jane@example.com")).toBeNull();
    expect(opaqueId("has space")).toBeNull();
    expect(opaqueId(null)).toBeNull();
  });
});
