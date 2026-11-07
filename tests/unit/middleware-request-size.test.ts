// The edge middleware answers a too-large request 413 before anything else reads it
// (Dispatch AR, lib/request-size.ts). Held on the source: the check is called with
// the request's method, path and headers, it answers 413 with the plain message,
// and it runs right after the CORS preflight — before the capability and billing
// switches, sign-in and every route. Installed by the Dispatch AR CEO script with
// the middleware edit.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");

describe("middleware: too-large requests", () => {
  it("imports and calls the size rule on the request itself", () => {
    expect(source).toMatch(/import \{ TOO_LARGE_MESSAGE, requestTooLarge \} from "@\/lib\/request-size";/);
    expect(source).toMatch(/requestTooLarge\(req\.method, pathname, req\.headers\)/);
  });

  it("answers 413 with the plain message, through finish()", () => {
    expect(source).toMatch(
      /finish\(NextResponse\.json\(\{ error: TOO_LARGE_MESSAGE \}, \{ status: 413 \}\)\)/,
    );
  });

  it("runs after the preflight and before every other check", () => {
    const at = (s: string) => {
      const i = source.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const size = at("requestTooLarge(req.method");
    expect(size).toBeGreaterThan(at("isPreflight(req.method"));
    expect(size).toBeLessThan(at("isPathDisabledByCapability(pathname)"));
    expect(size).toBeLessThan(at("isPathDisabledByBilling(pathname)"));
    expect(size).toBeLessThan(at("const isProtected"));
  });
});
