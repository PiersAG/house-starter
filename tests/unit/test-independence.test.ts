// @vitest-environment node
// Tests that behave the same locally and in CI (app-business-core issue 740; Matt Murphy
// #208). The two requirements, word for word, and the rules below that hold them:
//
//   R0962 "tests that depend on other tests or not tests their assumptions"
//         → no test forces an order (serial mode); browser specs make their own
//           accounts (uniqueEmail) and send their own client addresses (addressFor),
//           so no test spends or reads another's data; the unit suite runs in random
//           order every run (vitest.config.ts sequence.shuffle).
//   R0963 "the timeout you never thought about triggers the race condition that never
//         reproduces locally"
//         → no fixed sleeps in place of waiting for a condition; the unit suite's time
//           limit is chosen, not the default; a browser test that passes only on its
//           retry fails CI (playwright.config.ts failOnFlakyTests).
//
// The rule in full: docs/test-independence.md.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const TESTS = join(ROOT, "tests");

/** Folders of browser (Playwright) tests: they share one running app between tests. */
const BROWSER_DIRS = ["e2e", "isolation", "layout", "responsive", "a11y", "awkward"];

/**
 * Browser specs allowed a fixed email address, each with its reason. Every other
 * account comes from uniqueEmail (tests/support/browser.ts).
 */
const FIXED_ACCOUNTS: Record<string, string> = {
  "tests/layout/layout-guardrail.spec.ts":
    "the address and name are drawn in the compared screenshot, so they must not change; a retry signs the existing account in",
  "tests/isolation/per-tenant.spec.ts":
    "two planted tenants written straight into databases the spec creates fresh on every run",
  "tests/e2e/payload-audit.spec.ts": "a sample string fed to the leak checker, not an account",
  "tests/isolation/shared.spec.ts": "inside a comment",
};

/** Files whose sleeps are poll intervals inside a loop that checks real state. */
const POLLING: Record<string, string> = {
  "tests/integration/billing-grace.test.ts":
    "waits between polls of the payment provider's test clock and event list; each loop checks the state it waits for",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__screenshots__" || name === "fixtures" ? [] : files(full);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [full] : [];
  });
}
const rel = (f: string) => relative(ROOT, f).split("\\").join("/");
const ALL = files(TESTS).filter((f) => rel(f) !== "tests/unit/test-independence.test.ts");
const BROWSER = ALL.filter((f) => BROWSER_DIRS.some((d) => rel(f).startsWith(`tests/${d}/`)));

function hits(list: string[], pattern: RegExp, allow: (file: string, line: string, prev: string) => boolean = () => false) {
  const out: string[] = [];
  for (const f of list) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (pattern.test(line) && !allow(rel(f), line, lines[i - 1] ?? "")) out.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe("R0962: no test depends on another test", () => {
  it("finds the browser specs", () => {
    expect(BROWSER.length).toBeGreaterThan(20);
  });

  it("no test forces the order tests run in", () => {
    expect(hits(ALL, /mode:\s*["']serial["']|describe\.serial\(/)).toEqual([]);
  });

  it("browser specs make their own accounts (uniqueEmail), not fixed ones", () => {
    const email = /[\w.'+-]+@[\w-]+\.(test|example|com|org|net)\b/;
    expect(hits(BROWSER, email, (file) => file in FIXED_ACCOUNTS)).toEqual([]);
  });

  it("browser specs use their own client address (addressFor), not a fixed one", () => {
    const address = /["'`](203\.0\.113|198\.51\.100|192\.0\.2|198\.1[89])\.\d+["'`]/;
    expect(hits(BROWSER, address)).toEqual([]);
  });

  it("the unit suite runs in random order every run", () => {
    const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/sequence:\s*\{\s*shuffle:\s*true\s*\}/);
  });

  it("the browser suites run fully parallel, so no file leans on its neighbours", () => {
    const config = readFileSync(join(ROOT, "playwright.config.ts"), "utf8");
    expect(config).toMatch(/fullyParallel:\s*true/);
  });
});

describe("R0963: no test leans on timing", () => {
  it("no fixed waits in place of waiting for something", () => {
    expect(hits(ALL, /\bwaitForTimeout\s*\(/)).toEqual([]);
  });

  it("no sleeps, unless the line says why it is safe or the file is a declared poll", () => {
    const sleep = /new Promise\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*setTimeout\s*\(/;
    const allow = (file: string, line: string, prev: string) =>
      file in POLLING || /timing-safe:/.test(line) || /timing-safe:/.test(prev);
    expect(hits(ALL, sleep, allow)).toEqual([]);
  });

  it("the unit suite's time limit is chosen, not the 5-second default", () => {
    const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/testTimeout:\s*\d/);
    expect(config).toMatch(/hookTimeout:\s*\d/);
  });

  it("a browser test that passes only on its retry fails CI", () => {
    const config = readFileSync(join(ROOT, "playwright.config.ts"), "utf8");
    expect(config).toMatch(/failOnFlakyTests:\s*!!process\.env\.CI/);
  });

  it("every allowance names a file that exists", () => {
    for (const f of [...Object.keys(FIXED_ACCOUNTS), ...Object.keys(POLLING)]) {
      expect(statSync(join(ROOT, f)).isFile(), f).toBe(true);
    }
  });
});
