// The one required check (app-business-core #776, #450 — Matt Murphy #83: "your
// CI pipeline should run your test suite your linter your build verification and
// your security scan on every pull request before it's allowed to merge if any
// check fails the merge is blocked").
//
// build-init requires the check named "All CI checks passed" on every app repo's
// `main` (agents/build-init.py CI_ALL_PASSED_CHECK; pinned on that side by
// tests/contract/test_branch_protection_at_creation.py). It is reported by the
// `all-ci-passed` job below, so these properties are the whole guarantee:
//   1. its name is exactly that literal (a rename would require a check that
//      never arrives and block every merge);
//   2. it `needs:` EVERY other job in ci.yml, so a job added later cannot be
//      left out of what blocks a merge;
//   3. it runs `if: always()` and fails unless every needed job succeeded;
//   4. ci.yml runs on every pull request, with no path filter.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CI = readFileSync(join(__dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
const jobsBlock = CI.slice(CI.indexOf("\njobs:\n"));
const jobIds = [...jobsBlock.matchAll(/^ {2}([a-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
const start = jobsBlock.indexOf("\n  all-ci-passed:\n");
const nextJob = jobsBlock.slice(start + 1).search(/\n {2}[a-z0-9_-]+:\s*\n/);
const job = nextJob === -1 ? jobsBlock.slice(start) : jobsBlock.slice(start, start + 1 + nextJob);

describe("all-ci-passed (the one required CI check)", () => {
  it("exists and carries the exact name build-init requires", () => {
    expect(start).toBeGreaterThan(-1);
    expect(job).toMatch(/^ {4}name: All CI checks passed$/m);
  });

  it("needs every other job in ci.yml", () => {
    const m = job.match(/^ {4}needs: \[([^\]]*)\]$/m);
    expect(m).not.toBeNull();
    const needs = m![1].split(",").map((s) => s.trim()).sort();
    const others = jobIds.filter((id) => id !== "all-ci-passed").sort();
    expect(others.length).toBeGreaterThanOrEqual(4);
    expect(needs).toEqual(others);
  });

  it("always reports, and passes only when every needed job succeeded", () => {
    expect(job).toMatch(/^ {4}if: always\(\)$/m);
    expect(job).toContain('r.get("result") != "success"');
    expect(job).toContain("sys.exit(1)");
  });

  it("runs on every pull request with no path filter", () => {
    const on = CI.slice(CI.indexOf("\non:\n"), CI.indexOf("\njobs:\n"));
    expect(on).toMatch(/^ {2}pull_request:\n {4}branches: \["\*\*"\]$/m);
    expect(on).not.toMatch(/paths/);
  });
});
