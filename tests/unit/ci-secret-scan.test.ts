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

  // app-business-core Dispatch BZ-fix2: gitleaks' defaults know only sk-ant-api03- and
  // sk-ant-admin01- keys, so the scan carries one more rule for every Anthropic key shape,
  // including the Claude Console's current sk-ant-usr- keys. Made-up values, built here.
  it("catches Claude keys of every shape, including sk-ant-usr-", () => {
    const toml = ci.slice(ci.indexOf("<<'TOML'"), ci.indexOf("          TOML\n"));
    expect(toml).toContain("useDefault = true");
    expect(toml).toContain('id = "anthropic-key-any-format"');
    const m = toml.match(/regex = '''(.+)'''/);
    expect(m).not.toBeNull();
    const rule = new RegExp(m![1]);
    const body = "Ab3_-".repeat(19) + "AA";
    for (const kind of ["usr", "api03", "admin01", "oat01"]) {
      expect(rule.test(`KEY = "${"sk-" + "ant-" + kind + "-" + body}"`)).toBe(true);
    }
    expect(rule.test("sk-ant-api03-@@RAND40@@")).toBe(false);
  });

  it("the placeholder test holds no key-shaped value", () => {
    const text = readFileSync("tests/unit/billing-placeholder.test.ts", "utf8");
    expect(text).not.toMatch(/\b[rs]k_(live|test)_/);
  });
});
