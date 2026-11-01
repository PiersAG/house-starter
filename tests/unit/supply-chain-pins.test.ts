// app-business-core #750 — pin and review every infrastructure dependency.
// "Pin every infrastructure dependency to a specific version so a deployment
// cannot silently pull a different release through package-manager defaults."
//
// scripts/check-pins.py is the guard (also a CI step, so every app built from
// this template runs it). These cases run the real script against this repo
// and against throwaway repos, and hold the Renovate preset that keeps the pins
// on the reviewed weekly schedule (#716).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const GUARD = join(ROOT, "scripts", "check-pins.py");
const dirs: string[] = [];

function guard(root: string) {
  const r = spawnSync("python3", [GUARD, "--root", root], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "pins-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("check-pins", () => {
  it("passes on this repository", () => {
    const r = guard(ROOT);
    expect(r.out).toContain("Infrastructure pins: PASS");
    expect(r.code).toBe(0);
  });

  it.each([
    ["an action on a version tag", { ".github/workflows/a.yml": "steps:\n  - uses: actions/checkout@v4\n" }, "actions:"],
    ["a -latest runner", { ".github/workflows/a.yml": "jobs:\n  x:\n    runs-on: ubuntu-latest\n" }, "runner:"],
    ["a dependency range", { "package.json": JSON.stringify({ dependencies: { a: "^0.1.1" } }) }, "npm:"],
    ["an override range", { "package.json": JSON.stringify({ overrides: { a: ">=8.5.23" } }) }, "npm:"],
    ["an image without a digest", { Dockerfile: "FROM node:24-slim\n" }, "docker:"],
    ["a pip install by name", { ".github/workflows/a.yml": "run: pip install requests\n" }, "pip:"],
  ])("fails %s", (_name, files, rule) => {
    const r = guard(repo(files as Record<string, string>));
    expect(r.code).toBe(1);
    expect(r.out).toContain(rule);
  });

  it("allows PiersAG's own reusable workflows at their release tags", () => {
    const r = guard(
      repo({
        ".github/workflows/a.yml":
          "jobs:\n  g:\n    uses: PiersAG/house-starter/.github/workflows/toolchain-guard.yml@toolchain-guard-v1\n",
      }),
    );
    expect(r.code).toBe(0);
  });
});

describe("pinned surfaces", () => {
  it("reads the toolchain guard script at its release tag, not main", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/toolchain-guard.yml"), "utf8");
    expect(wf).toMatch(/repository: PiersAG\/house-starter\n\s+ref: toolchain-guard-v1\n/);
  });

  it("runs the pin guard and the whole-lockfile audit in CI", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("python3 scripts/check-pins.py");
    expect(ci).toContain("python3 scripts/check-deps-existence.py --workspace .");
  });
});

describe("renovate-base.json (the reviewed update schedule)", () => {
  const preset = JSON.parse(readFileSync(join(ROOT, "renovate-base.json"), "utf8"));

  it("keeps every pin exact and updates it only on the weekly schedule", () => {
    expect(preset.extends).toEqual(
      expect.arrayContaining(["helpers:pinGitHubActionDigests", "docker:pinDigests"]),
    );
    expect(preset.rangeStrategy).toBe("pin");
    expect(preset.schedule).toEqual(["before 6am on monday"]);
    expect(preset.minimumReleaseAge).toBe("14 days");
  });

  it("compiles the hashed Python lock files and never edits them line by line", () => {
    expect(preset["pip-compile"].managerFilePatterns.join(" ")).toContain("requirements");
    expect(preset.pip_requirements.enabled).toBe(false);
  });

  it("merges non-major updates itself and leaves every major to the CEO", () => {
    const rules = preset.packageRules as Array<Record<string, unknown>>;
    const batch = rules.find((r) => r.groupSlug === "all-non-major");
    const majors = rules.find((r) => JSON.stringify(r.matchUpdateTypes) === '["major"]');
    expect(batch?.automerge).toBe(true);
    expect(majors?.automerge).toBe(false);
    expect(preset.platformAutomerge).toBe(true);
  });
});
