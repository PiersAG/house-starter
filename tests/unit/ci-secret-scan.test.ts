// The template's own secret scan (app-business-core #374, independent review of
// Dispatch AP): CI runs gitleaks on the checked-out tree with the apps' strict flags,
// and the money-path test that tripped it keeps no key-shaped value.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");

describe("the template's secret scan", () => {
  it("runs in the required ci job, before anything is installed", () => {
    const job = ci.slice(ci.indexOf("\n  ci:\n"));
    const scan = job.indexOf("name: Secret scan (gitleaks)");
    expect(scan).toBeGreaterThan(-1);
    expect(scan).toBeLessThan(job.indexOf("name: Install dependencies"));
  });

  it("cannot be weakened from inside the repo", () => {
    expect(ci).toContain("--ignore-gitleaks-allow");
    expect(ci).toContain("--gitleaks-ignore-path");
    expect(ci).toContain('--config "$work/gitleaks.toml"');
    expect(ci).toContain("--exit-code 2");
  });

  it("the placeholder test holds no key-shaped value", () => {
    const text = readFileSync("tests/unit/billing-placeholder.test.ts", "utf8");
    expect(text).not.toMatch(/\b[rs]k_(live|test)_/);
  });
});
