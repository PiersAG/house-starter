// @vitest-environment node
// The correctness gate (app-business-core issue 413, UIX.20): "a named gate covering
// accessibility/contrast, visual-regression, layout-overflow and automated tests — the
// non-security half of 'production-ready'". Held here: the named CI job exists, blocks
// merges, and runs each leg; the legs it leaves to the `ci` job are still there.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDroppedPrefetch } from "../support/browser";

const ROOT = join(__dirname, "..", "..");
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const PW = readFileSync(join(ROOT, "playwright.config.ts"), "utf8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

function job(id: string): string {
  const start = CI.indexOf(`\n  ${id}:\n`);
  if (start === -1) return "";
  const rest = CI.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9_-]+:\s*\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const GATE = job("correctness-gate");

describe("the correctness gate is one named, blocking CI job", () => {
  it("exists with its name", () => {
    expect(GATE).toMatch(/^ {4}name: Correctness gate \(accessibility, awkward input, browsers\)$/m);
  });

  it("blocks every merge: All CI checks passed waits for it", () => {
    expect(job("all-ci-passed")).toMatch(/needs: \[[^\]]*\bcorrectness-gate\b[^\]]*\]/);
  });

  it("installs all three browser engines", () => {
    expect(GATE).toMatch(/playwright install --with-deps chromium firefox webkit/);
  });
});

describe("its legs", () => {
  it("accessibility and contrast on every page, desktop and phone (issue 720)", () => {
    expect(PKG.scripts["test:correctness"]).toContain("--project=a11y ");
    expect(PKG.scripts["test:correctness"]).toContain("--project=a11y-phone");
    expect(PW).toMatch(/name: "a11y",\s*testDir: "\.\/tests\/a11y"/);
  });

  it("awkward input on every browser and device (issue 721)", () => {
    for (const p of [
      "awkward-chromium",
      "awkward-firefox",
      "awkward-webkit",
      "awkward-iphone-2019",
      "awkward-android-2019-slow",
      "awkward-320-slow",
    ]) {
      expect(PKG.scripts["test:correctness"], p).toContain(`--project=${p}`);
      expect(PW, p).toContain(`name: "${p}"`);
    }
    expect(GATE).toMatch(/run: npm run test:correctness/);
  });

  it("the oldest supported browser runs every shipped script, checked on the build", () => {
    const build = GATE.indexOf("run: npm run build");
    const floor = GATE.indexOf("run: npm run check:browser-floor");
    expect(build).toBeGreaterThan(-1);
    expect(floor).toBeGreaterThan(build);
  });

  it("layout overflow and visual regression stay in the ci job (the layout guardrail)", () => {
    expect(job("ci")).toMatch(/name: Layout regression guardrail \(overflow \+ visual baselines\)/);
    expect(job("ci")).toMatch(/npm run test:layout/);
  });

  it("automated tests: unit and e2e suites run in ci, in random order, flaky fails", () => {
    expect(job("ci")).toMatch(/npm run test:coverage/);
    expect(job("ci")).toMatch(/npm run test:e2e/);
    expect(readFileSync(join(ROOT, "vitest.config.ts"), "utf8")).toMatch(/shuffle: true/);
    expect(PW).toMatch(/failOnFlakyTests: !!process\.env\.CI/);
  });

  it("the gate's own document names every leg", () => {
    const doc = readFileSync(join(ROOT, "docs", "correctness-gate.md"), "utf8");
    for (const leg of ["Accessibility", "Awkward input", "Oldest browser", "Layout overflow", "Visual regression", "Automated tests"]) {
      expect(doc, leg).toContain(leg);
    }
  });
});

describe("the browser failure watch", () => {
  it("lets through only a dropped prefetch, never another script error", () => {
    expect(isDroppedPrefetch("/localhost:3001/dashboard?_rsc=Uj5fJzh3oSqZfPD_ due to access control checks.")).toBe(true);
    expect(isDroppedPrefetch("/localhost:3001/api/account due to access control checks.")).toBe(false);
    expect(isDroppedPrefetch("TypeError: undefined is not an object")).toBe(false);
  });
});
