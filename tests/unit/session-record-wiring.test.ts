// The sign-in kernel and the edge middleware wire in the session record and the
// return path (app-business-core issues 506, 519, 525, 741, 559). The behaviour is
// proven against a real database in tests/unit/session-records.test.ts and against
// the running app in tests/e2e/session-devices.spec.ts and return-path.spec.ts;
// this proves the kernel actually passes it in, so it cannot be quietly dropped.
// Added by the dispatch AH CEO script (the safety gate keeps kernel edits from
// Claude Code).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const kernel = readFileSync(join(process.cwd(), "lib", "auth.ts"), "utf8");
const edge = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");

describe("sign-in kernel: the session record", () => {
  it("takes the session's life from the one session setting (#559)", () => {
    expect(kernel).toMatch(/import \{ sessionMaxAge \} from "@\/lib\/session\/lifetime"/);
    expect(kernel).toContain("token.maxAge = sessionMaxAge(rememberMe);");
    expect(kernel).not.toMatch(/THIRTY_DAY_SECONDS|DAY_SECONDS/);
  });

  it("records the session at sign-in (#506 device cap, #519 new-device alert)", () => {
    const signIn = kernel.slice(kernel.indexOf("if (user?.id) {"), kernel.indexOf("return token;", kernel.indexOf("if (user?.id) {")));
    expect(signIn).toContain("await onSessionStart(catalogDb, token);");
  });

  it("checks the record at renewal (#506, #519, #741)", () => {
    const call = kernel.slice(kernel.indexOf("return handleTokenRenewal("));
    const args = call.slice(0, call.indexOf(");") + 2);
    expect(args).toContain("(t, nowSeconds) => checkSessionRecord(catalogDb, t, nowSeconds)");
  });
});

describe("edge middleware: the return path (#525)", () => {
  it("a sign-in redirect carries the page to come back to", () => {
    expect(edge).toContain('loginUrl.searchParams.set("callbackUrl", `${pathname}${req.nextUrl.search}`);');
  });
});
