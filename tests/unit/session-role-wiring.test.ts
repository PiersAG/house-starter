// The sign-in kernel wires the renewal-time role refresh (#527) and the
// session-id rotation at a privilege change (#798). The behaviour is proven
// against a real database in tests/unit/revoked-sessions.test.ts; this proves
// the kernel actually passes it in, so the jwt callback cannot quietly drop it.
// Added by the dispatch W CEO script (the safety gate keeps kernel edits from
// Claude Code). SESSION_KERNEL_SOURCE points it at a draft for a dry run.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  process.env.SESSION_KERNEL_SOURCE ?? join(process.cwd(), "lib", "auth.ts"),
  "utf8",
);

describe("sign-in kernel: renewal re-reads the role and rotates on a change", () => {
  it("imports the role read and the revocation", () => {
    expect(source).toMatch(/\breadSessionRole\b[\s\S]*from "@\/lib\/revoked-sessions"/);
    expect(source).toMatch(/\brevokeSession\b[\s\S]*from "@\/lib\/revoked-sessions"/);
  });

  it("passes both to handleTokenRenewal against the catalog", () => {
    const call = source.slice(source.indexOf("return handleTokenRenewal("));
    const args = call.slice(0, call.indexOf(");") + 2);
    expect(args).toContain("readRole: (userId) => readSessionRole(catalogDb, userId)");
    expect(args).toContain("revoke: (jti, userId) => revokeSession(catalogDb, jti, userId)");
  });
});
