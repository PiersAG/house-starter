// @vitest-environment node
// Every code path that deletes, wipes or erases a customer database, or
// deletes a tenant row, is one of the known, guarded paths (Dispatch AG-fix3;
// app-business-core issues 358 and 857). Each is guarded so it can never touch
// a tenant another account still links:
//
//   sign-up rollback  lib/tenant/signup-provisioning.ts rollBack — only the id
//                     this sign-up minted, and only after re-reading that no
//                     account links it (tests/unit/signup-rollback-safety.test.ts);
//   account erasure   lib/privacy/deletion.ts eraseAccount — only a tenant
//                     tenantErasable allows: no other account links it and, for
//                     an unfinished sign-up, it is the id that sign-up minted.
//                     Run by the retention job and by the replay after a restore;
//                     lib/privacy/runtime.ts liveTenantPlane is its live plane.
//
// A new call to one of these primitives anywhere else fails this test: guard
// it, test the guard, and add it to the list in house-starter #154.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const DIRS = ["app", "lib", "scripts"];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

/** Lines of code only: comment lines are skipped, so prose naming a primitive does not count. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const PRIMITIVES: { what: string; pattern: RegExp; allowed: string[] }[] = [
  {
    what: "removing a tenant database through the provisioner",
    pattern: /getProvisioner\([^)]*\)\.destroy\(/,
    allowed: ["lib/privacy/runtime.ts", "lib/tenant/signup-provisioning.ts"],
  },
  {
    what: "removing a tenant database through a tenant plane",
    pattern: /tenantPlane\.destroy\b/,
    allowed: ["lib/privacy/deletion.ts"],
  },
  {
    what: "wiping a tenant database",
    pattern: /\bwipeTenantDatabase\(/,
    allowed: ["lib/privacy/deletion.ts"],
  },
  {
    what: "deleting a tenant row",
    pattern: /\.delete\(\s*tenants\s*\)|DELETE\s+FROM\s+["`']?tenants\b/i,
    allowed: ["lib/tenant/signup-provisioning.ts"],
  },
  {
    what: "erasing an account (its tenant row and database with it)",
    pattern: /\beraseAccount\(/,
    allowed: ["lib/privacy/deletion.ts", "lib/privacy/retention-job.ts"],
  },
  {
    what: "a DELETE sent to Turso's database API",
    pattern: /tursoFetch\([\s\S]{0,300}?method:\s*["']DELETE["']/,
    allowed: ["lib/tenant/provisioner.ts"],
  },
];

describe("every path that deletes a customer database or a tenant row is a known, guarded one", () => {
  const files = DIRS.flatMap((d) => sources(join(ROOT, d))).map((p) => ({
    rel: relative(ROOT, p).split("\\").join("/"),
    text: code(p),
  }));

  for (const { what, pattern, allowed } of PRIMITIVES) {
    it(`${what}: only ${allowed.join(", ")}`, () => {
      const found = files.filter((f) => pattern.test(f.text)).map((f) => f.rel).sort();
      expect(found).toEqual([...allowed].sort());
    });
  }

  it("the erasure decides its tenant through tenantErasable before touching it", () => {
    const deletion = code(join(ROOT, "lib/privacy/deletion.ts"));
    const guard = deletion.indexOf("await tenantErasable(db, user)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(deletion.indexOf("wipeTenantDatabase(await opts.tenantPlane.open"));
  });

  it("the rollback re-reads who links its minted id before deleting the database", () => {
    const rollback = code(join(ROOT, "lib/tenant/signup-provisioning.ts"));
    const read = rollback.indexOf('step("read-links"');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(rollback.indexOf('step("delete-database"'));
  });
});
