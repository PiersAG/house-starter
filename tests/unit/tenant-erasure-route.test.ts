// @vitest-environment node
// How a customer's database is deleted without the running app holding a
// delete right (Dispatch AO; app-business-core issues 439 and 722), and what is
// said about Turso's restore history. The factory side — the delete-only key,
// the read-only catalog key, the re-check and the brake — is tested in
// app-business-core (tests/contract/test_tenant_erase.py).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CREDENTIAL_MODE } from "@/lib/tenant/db-credentials";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("deleting a customer's database", () => {
  it("the app's provisioner never asks Turso to delete outside destroy(), which Turso refuses the app's key", () => {
    const src = read("lib/tenant/provisioner.ts");
    expect(src.match(/method: "DELETE"/g)).toHaveLength(1);
  });

  it("the keys document names the route, the brake and the read-only catalog key", () => {
    const doc = read("docs/keys-inside-the-app.md");
    expect(doc).toContain("tenant-erase.yml");
    expect(doc).toMatch(/read-only key for the catalog/);
    expect(doc).toMatch(/at most 10 databases in one run/);
    expect(doc).toMatch(/An unclear answer clears nothing/);
  });

  it("the gap on Turso's restore history is stated plainly, with the off-site copy's 30 days", () => {
    for (const doc of [read("docs/keys-inside-the-app.md"), read("docs/legal/retention-policy.md")]) {
      expect(doc).toMatch(/restore points of a deleted\s+database (is|has) not (been )?confirmed/);
      expect(doc).toMatch(/30-day lock|kept for 30 days/);
      expect(doc).toMatch(/replay-erasures/);
    }
    expect(read("docs/legal/retention-policy.md")).not.toMatch(/removed with its restore history/);
  });

  it("no tenant database key outlives an hour by default (D7)", () => {
    expect(DEFAULT_CREDENTIAL_MODE).toBe("short-lived");
    expect(read("docs/keys-inside-the-app.md")).toMatch(/\| `short-lived`, `stored` \| `short-lived` \|/);
  });
});
