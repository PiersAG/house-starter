// HARD.08 (app-business-core #464), part 1: ABSENCE IS A DIVERGENCE.
//
// scripts/check-toolchain.py used to check engines.node / engines.npm only when
// they were present, so deleting engines.node passed clean — and Vercel reads
// engines.node to pick the deployed Node. Now a missing key fails the guard.
// Each case runs the real script against a throwaway repo.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GUARD = join(__dirname, "..", "..", "scripts", "check-toolchain.py");
const dirs: string[] = [];

function run(engines: Record<string, string> | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "toolchain-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".node-version"), "24.22.1\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", ...(engines ? { engines } : {}) }));
  const r = spawnSync("python3", [GUARD], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("check-toolchain engines", () => {
  it("passes with engines.node on the pin and engines.npm >= 11", () => {
    const r = run({ node: "24.x", npm: ">=11" });
    expect(r.out).toContain("PASS");
    expect(r.code).toBe(0);
  });

  it("fails when engines.node is deleted", () => {
    const r = run({ npm: ">=11" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("engines.node missing");
  });

  it("fails when engines.npm is deleted", () => {
    const r = run({ node: "24.x" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("engines.npm missing");
  });

  it("fails when engines is deleted altogether", () => {
    const r = run(undefined);
    expect(r.code).toBe(1);
    expect(r.out).toContain("engines.node missing");
  });

  it("still fails a present but divergent engines.node", () => {
    const r = run({ node: "22.x", npm: ">=11" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("not locked to major 24");
  });
});
