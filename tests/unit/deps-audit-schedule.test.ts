// app-business-core #964 (Dispatch AD-fix2) — the lockfile audit runs daily on
// main, so an outside change (a maintainer added to a locked package, as with
// semver 7.8.6 on 2026-11-02) shows up as a red scheduled run, not as a stop in
// the middle of a PR or a CEO script.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("daily dependency audit", () => {
  const wf = read(".github/workflows/deps-audit.yml");

  it("runs on a daily schedule, and by hand", () => {
    const cron = wf.match(/^\s*-\s*cron:\s*"([^"]+)"/m);
    expect(cron, "deps-audit.yml has no schedule").not.toBeNull();
    const [minute, hour, dom, month, dow] = cron![1].split(/\s+/);
    expect([minute, hour].every((f) => /^\d+$/.test(f))).toBe(true);
    expect([dom, month, dow]).toEqual(["*", "*", "*"]);
    expect(wf).toMatch(/^\s*workflow_dispatch:/m);
  });

  it("runs the same check as CI, read-only", () => {
    const command =
      'python3 scripts/check-deps-existence.py --workspace . --cache-dir "$RUNNER_TEMP/deps-audit"';
    expect(wf).toContain(command);
    expect(read(".github/workflows/ci.yml")).toContain(command);
    expect(wf).toMatch(/^permissions:\n\s+contents: read\s*$/m);
    expect(wf).not.toMatch(/contents:\s*write/);
  });

  it("is not limited to pull requests or pushes", () => {
    expect(wf).not.toMatch(/^\s*(pull_request|push):/m);
  });
});
