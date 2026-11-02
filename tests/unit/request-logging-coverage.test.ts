// @vitest-environment node
//
// Every API route writes one structured log line per request and returns its
// request id (#503), and the public health answer never carries a database's
// own error text (#444). Read from the route files themselves, so a new route
// that skips the wrapper fails here rather than going unlogged.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportedMethods } from "../isolation/route-map";
import { DB_UNREACHABLE, pingDatabase } from "@/lib/health/db-ping";
import { __resetSinkForTests } from "@/lib/observability/error-log";
import { requestIdOf } from "../../instrumentation";

const ROOT = join(__dirname, "..", "..");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...routeFiles(rel));
    else if (name === "route.ts") out.push(rel);
  }
  return out;
}

// The sign-in kernel (app/api/auth/**) is changed only by the CEO (the safety
// gate protects it); its events are already one line each through
// lib/security-log.ts, and every response still carries the request id the
// middleware sets.
const KERNEL = /^app\/api\/auth\//;

describe("request logging coverage (#503)", () => {
  const files = routeFiles("app/api").filter((f) => !KERNEL.test(f));

  it("finds the routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(files)("%s wraps every handler in withRequestLog", (file) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    const methods = exportedMethods(src);
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) {
      expect(src, `${file} ${m}`).toMatch(new RegExp(`export const ${m} = withRequestLog\\(`));
    }
  });
});

describe("health detail is fixed (#444)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DATABASE_URL;
    __resetSinkForTests();
  });

  it("a failing database ping returns a fixed reason and logs the raw text privately", async () => {
    __resetSinkForTests();
    // A path that cannot be opened: the driver's text names the path.
    process.env.DATABASE_URL = "file:/nonexistent-dir-s12/secret-host.db";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await pingDatabase();
    expect(r).toEqual({ ok: false, detail: DB_UNREACHABLE });
    expect(JSON.stringify(r)).not.toContain("secret-host");
    expect(err).toHaveBeenCalled();
  });

  it("the health route maps a failure only through the fixed reasons", () => {
    const route = readFileSync(join(ROOT, "app/api/health/route.ts"), "utf8");
    expect(route).not.toMatch(/\.message/);
    const checks = readFileSync(join(ROOT, "lib/health/checks.ts"), "utf8");
    expect(checks).not.toMatch(/detail:\s*e instanceof Error/);
  });
});

describe("the error row from Next.js carries the request id (#503)", () => {
  it("reads a well-formed x-request-id and ignores anything else", () => {
    expect(requestIdOf({ "x-request-id": "0b6f8c9e-1d2a-4f3b-9c8d-7e6f5a4b3c2d" })).toBe(
      "0b6f8c9e-1d2a-4f3b-9c8d-7e6f5a4b3c2d",
    );
    expect(requestIdOf({ "x-request-id": ["abcdefgh-1234"] })).toBe("abcdefgh-1234");
    expect(requestIdOf({ "x-request-id": "bad id" })).toBeNull();
    expect(requestIdOf(undefined)).toBeNull();
  });
});

void relative;
