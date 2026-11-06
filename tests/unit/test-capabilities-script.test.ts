// `npm run test:capabilities` (app-business-core #380): the clean-up gate's check that
// flag-gated code was not deleted. It must exist by that exact name, cover every flag
// in both states, name only tests that exist, and leave the config as it found it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG, FLAGS, STATES, TESTS } from "../../scripts/test-capabilities.mjs";
import { enabledCapabilities } from "@/config/capabilities";

const ROOT = join(__dirname, "..", "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "test-capabilities.mjs"), "utf8");

describe("test:capabilities", () => {
  it("is the named script the clean-up gate calls", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["test:capabilities"]).toBe("node scripts/test-capabilities.mjs");
  });

  it("covers every capability flag in both states", () => {
    expect([...FLAGS].sort()).toEqual(Object.keys(enabledCapabilities).sort());
    expect(STATES).toEqual(["on", "off"]);
  });

  it("names only test files that exist, the R1-R5 ones included", () => {
    expect(TESTS).toContain("tests/unit/capability-admission.test.ts");
    expect(TESTS).toContain("tests/unit/capability-both-states.test.ts");
    for (const file of TESTS) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  it("puts the config back whatever happens, and fails when any leg fails", () => {
    expect(CONFIG).toBe("config/capabilities.ts");
    expect(SCRIPT).toMatch(/finally \{\s*restore\(\);/);
    expect(SCRIPT).toContain("SIGTERM");
    expect(SCRIPT).toContain("process.exit(1)");
  });
});
