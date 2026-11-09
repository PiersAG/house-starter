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
    // Made-up key, built at run time so no key-shaped value sits in this file for the
    // secret scan to find.
    expect(scrubText(`key ${["sk", "test", "51HxYz9AbCdEfGhIjKlMnOpQr"].join("_")}`)).toBe("key [redacted]");
    expect(scrubText("call 07700 900123 or +44 7700 900 123")).toBe("call [number] or [number]");
    expect(scrubText("card 4242 4242 4242 4242")).toBe("card [number]");
  });

  it("keeps what is needed to fix the fault: times, dates, short numbers and plain words", () => {
    expect(scrubText("timeout at 10:30:45 on 2026-11-05 after 3000 ms")).toBe(
      "timeout at 10:30:45 on 2026-11-05 after 3000 ms",
    );
    expect(scrubText("Unexpected token < in JSON at position 0")).toBe("Unexpected token < in JSON at position 0");
  });

  // Review 2 of Dispatch AT, CEO ruling 2026-11-09: default-deny. Every quoted
  // value goes, code-like or not; only an exact match on the app's own fixed
  // words is kept (tests/unit/sentry-allow.test.ts).
  it("removes every quoted value, code names included", () => {
    expect(scrubText('Invalid name "Jane Doe" for dog "Rex 2024"')).toBe("Invalid name [redacted] for dog [redacted]");
    expect(scrubText("value 'a@b' refused")).toBe("value [redacted] refused");
    expect(scrubText('{"received":"Jane"}')).toBe("{[redacted]:[redacted]}");
    expect(scrubText("Cannot read properties of undefined (reading 'tenantId')")).toBe(
      "Cannot read properties of undefined (reading [redacted])",
    );
    expect(scrubText("no column 'user.tenantId' in 'lib/db', 'node:fs', code 'SQLITE_ERROR', a 'TypeError'")).toBe(
      "no column [redacted] in [redacted], [redacted], code [redacted], a [redacted]",
    );
  });

  // Review 1 of Dispatch AT: these quoted values reached Sentry as "code names".
  it("removes quoted usernames, email local parts, slugs and capitals words", () => {
    for (const v of ["'jsmith'", '"jane"', '"jane.doe"', '"smith-plumbing"', '"JANE"', "'jane_doe'", '"JaneDoe"', "'janeDoe'", "'users.email'"]) {
      expect(scrubText(`user ${v} not found`)).toBe("user [redacted] not found");
    }
    expect(scrubText('{"username":"jsmith","slug":"smith-plumbing"}')).toBe(
      "{[redacted]:[redacted],[redacted]:[redacted]}",
    );
    expect(scrubText('{"Jane Doe": 1, "a@b": 2}')).toBe("{[redacted]: 1, [redacted]: 2}");
  });

  it("removes a quoted value followed by a colon, and a JSON key", () => {
    expect(scrubText("user 'jsmith': not found")).toBe("user [redacted]: not found");
    expect(scrubText('tenant "smith-plumbing": access denied')).toBe("tenant [redacted]: access denied");
    expect(scrubText('{"jsmith": 1}')).toBe("{[redacted]: 1}");
  });

  it("does not take an apostrophe inside a word for a quote", () => {
    expect(scrubText("Couldn't find user 'jsmith'")).toBe("Couldn't find user [redacted]");
    expect(scrubText("Can't load 'jane'")).toBe("Can't load [redacted]");
    expect(scrubText("O'Brien's account 'ob123' locked")).toBe("O'Brien's account [redacted] locked");
    expect(scrubText("user 'jsmith's dog' gone")).toBe("user [redacted] gone");
    expect(scrubText("Couldn’t find user ‘jsmith’")).toBe("Couldn’t find user [redacted]");
    // A possessive's apostrophe does not open a value, so the quoted one after it goes.
    expect(scrubText("the users' file 'jsmith' gone")).toBe("the users' file [redacted] gone");
  });

  it("removes backtick-quoted values and an unclosed quote's rest of line", () => {
    expect(scrubText("no row for `jsmith` in `smith-plumbing`")).toBe("no row for [redacted] in [redacted]");
    expect(scrubText("user 'jsmith not found\nnext line")).toBe("user [redacted]\nnext line");
  });

  it("keeps a quoted value only on an exact match with the app's own fixed words", () => {
    expect(scrubText("'DATABASE_URL' is not set")).toBe("'DATABASE_URL' is not set");
    expect(scrubText("'STRIPE_SECRET_KEY' is not set")).toBe("'STRIPE_SECRET_KEY' is not set");
    expect(scrubText("status 'past_due' and \"trialing\"")).toBe("status 'past_due' and \"trialing\"");
    for (const v of ["'STRIPE_SECRET_KEY_jsmith'", "'jsmith'", "'trialing-acme'", "'Trialing'", "' past_due'", "'STRIPE_KEY'"]) {
      expect(scrubText(`got ${v} here`)).toBe("got [redacted] here");
    }
  });

  it("leaves a message with no quotes unchanged, apart from emails, phone and card numbers", () => {
    const plain = "Payment step failed for plan 3 after 2 tries (timeout)";
    expect(scrubText(plain)).toBe(plain);
    expect(scrubText("no account for jane@example.com, call 07700 900123")).toBe("no account for [email], call [number]");
  });

  it("removes an email written with %40 for the @, or %2540", () => {
    expect(scrubText("404 for https://api.example/contacts/jane%40example.com")).toBe(
      "404 for https://api.example/contacts/[email]",
    );
    expect(scrubText("no user JANE.DOE%40Example.CO.UK")).toBe("no user [email]");
    expect(scrubText("404 for /contacts/jane%2540example.com")).toBe("404 for /contacts/[email]");
  });

  it("removes phone numbers written with brackets and dots", () => {
    expect(scrubText("call (020) 7946 0958 now")).toBe("call [number] now");
    expect(scrubText("call 07700.900.123 now")).toBe("call [number] now");
    expect(scrubText("call (555) 123-4567 now")).toBe("call [number] now");
    expect(scrubText("call +44 (0)20 7946 0958")).toBe("call [number]");
    // A bracket the number does not close stays, so the text still reads.
    expect(scrubText("(ref 020 7946 0958)")).toBe("(ref [number])");
    expect(scrubText("(020 7946 0958)")).toBe("([number])");
  });

  it("keeps short dotted and bracketed numbers that are not phone numbers", () => {
    expect(scrubText("version 1.2.3 (build 42) took 12.5 ms")).toBe("version 1.2.3 (build 42) took 12.5 ms");
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
    expect(scrubPath("/u/jane%2540example.com")).toBe("/u/:id");
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
