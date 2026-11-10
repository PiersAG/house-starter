// @vitest-environment node
// Operator-granted comp (no-payment) accounts, in version 0 for every app
// (app-business-core issue 456): "every app ... needs the ability for the OPERATOR to
// grant a small number of accounts full app access WITHOUT a subscription — 'comp' /
// complimentary accounts ... MUST be granted from the OPERATOR CONTROL PLANE ... NOT
// self-service by a normal user."
//
// The mechanism is the one audited grant path (lib/billing/grants.ts): a `comp` grant
// reaches gated routes exactly as a subscription does (tests/unit/gate-grants.test.ts)
// and every grant is in the audit trail (tests/unit/billing-audit-s12.test.ts). This
// file holds the "operator only" half: nothing a user's request reaches can write a
// grant.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GRANT_TYPES } from "@/lib/billing/grants";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const WRITERS = /\b(grantAccess|revokeGrant)\b/;
// The two operator-side writers: the CEO's command (scripts/grant-access.ts, run by
// the operator against the app's catalog) and the deploy-time owner seed, which gives
// only the operator's own account its `owner` grant on the migration path.
const OPERATOR_SIDE = new Set(["scripts/grant-access.ts", "lib/owner-seed.ts", "lib/billing/grants.ts"]);

describe("#456 comp accounts are granted by the operator only", () => {
  it("comp is one of the grant kinds", () => {
    expect(GRANT_TYPES).toContain("comp");
  });

  it("no page, route or server action can write a grant", () => {
    const offenders = files("app").filter((f) => {
      const src = readFileSync(f, "utf8");
      return src.includes("lib/billing/grants") || WRITERS.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("outside the operator side, no code calls the grant writers", () => {
    const offenders = [...files("lib"), ...files("scripts")]
      .filter((f) => !OPERATOR_SIDE.has(f))
      .filter((f) => WRITERS.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the operator's command grants comp, with a note and an expiry", () => {
    const cli = readFileSync("scripts/grant-access.ts", "utf8");
    expect(cli).toMatch(/grant\s+--email .* --type/);
    expect(cli).toContain("--expires");
    expect(cli).toContain("--note");
  });
});
