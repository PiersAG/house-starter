/**
 * Hardcoded-colour gate — the standing guard that keeps a theme swap honest.
 *
 * Sibling of design-tokens.test.ts. That file pins the token CONTRACT (format,
 * mapping, measured contrast); this one pins that components actually USE it.
 * The two failures are different and both silent:
 *
 *   design-tokens.test.ts catches "the token is defined wrongly".
 *   this file catches   "the component never asked for the token at all".
 *
 * The second is the one that had actually shipped. The whole SupportWidget and
 * four primary buttons carried `bg-blue-600` / `text-white` / `text-red-600`,
 * so a palette swap changed every other surface and left those exactly as they
 * were — no error, no warning, a build that passes and a page that is wrong.
 * Nothing in the type system, the linter or the existing tests could see it,
 * because a hardcoded Tailwind class is perfectly valid code.
 *
 * Scope and carve-outs live in scripts/check-hardcoded-colours.mjs, which is
 * also runnable standalone: `node scripts/check-hardcoded-colours.mjs`.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Imported from a plain .mjs script, deliberately not TypeScript: the gate must
// stay runnable with bare `node` (npm run check:colours) with no transpile step.
import {
  scanForHardcodedColours,
  formatViolations,
  SCANNED_DIRS,
} from "../../scripts/check-hardcoded-colours.mjs";

const ROOT = resolve(__dirname, "../..");

describe("hardcoded-colour gate — the real tree", () => {
  it("finds no hardcoded colour in app/ or components/", () => {
    const { violations, filesScanned } = scanForHardcodedColours(ROOT);
    expect(filesScanned).toBeGreaterThan(0); // a scan that saw nothing proves nothing
    expect(
      violations,
      violations.length
        ? `\nHardcoded colours a theme swap cannot reach:\n${formatViolations(violations)}\n`
        : "",
    ).toEqual([]);
  });

  it("reports every exemption, so none can hide", () => {
    const { exemptions } = scanForHardcodedColours(ROOT);
    // Not a cap on how many there may be — a requirement that each states WHY.
    for (const e of exemptions) {
      expect(e.reason, `${e.file}:${e.line} is exempt with no reason given`).not.toBe("");
    }
  });
});

/**
 * The gate's own proof. A check nobody has watched fail is not a gate — it is a
 * line in a config file. These seed each violation class into a throwaway tree
 * and assert the scanner actually catches it.
 */
describe("hardcoded-colour gate — seeded failures", () => {
  function scanFixture(relPath: string, contents: string) {
    const dir = mkdtempSync(join(tmpdir(), "colour-gate-"));
    try {
      const full = join(dir, relPath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
      return scanForHardcodedColours(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const CAUGHT: Array<[string, string, string]> = [
    ["a raw palette class", "palette-class", `<div className="bg-blue-600" />`],
    ["a palette class behind a variant", "palette-class", `<div className="hover:text-red-500" />`],
    ["a palette class with an opacity modifier", "palette-class", `<div className="bg-emerald-700/50" />`],
    ["absolute white", "absolute-white-black", `<div className="text-white" />`],
    ["absolute black", "absolute-white-black", `<div className="bg-black/80" />`],
    ["a raw hex value", "raw-hex", `const brand = "#1d4ed8";`],
    ["a raw rgb() literal", "raw-colour-function", `const brand = "rgb(29 78 216)";`],
  ];

  it.each(CAUGHT)("catches %s", (_label, ruleId, line) => {
    const { violations } = scanFixture("components/Seeded.tsx", line);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].rule).toBe(ruleId);
    expect(violations[0].file).toBe("components/Seeded.tsx");
  });

  const ALLOWED: Array<[string, string]> = [
    ["token classes", `<div className="bg-primary text-primary-foreground border-border" />`],
    ["a token with an opacity modifier", `<div className="bg-primary/90 ring-ring/20" />`],
    ["a token read through hsl(var())", `const c = "hsl(var(--primary))";`],
    ["an unrelated numeric class", `<div className="z-50 min-h-11 gap-4" />`],
    ["a same-line exemption", `<div className="bg-black/80" /> {/* theme-exempt: scrim */}`],
  ];

  it.each(ALLOWED)("allows %s", (_label, line) => {
    const { violations } = scanFixture("components/Seeded.tsx", line);
    expect(violations).toEqual([]);
  });

  it("honours an exemption on the line above, and records its reason", () => {
    const { violations, exemptions } = scanFixture(
      "components/Seeded.tsx",
      ["// theme-exempt: modal scrim", `<div className="bg-black/80" />`].join("\n"),
    );
    expect(violations).toEqual([]);
    expect(exemptions).toHaveLength(1);
    expect(exemptions[0].reason).toBe("modal scrim");
  });

  it("does not scan lib/, which is what keeps email templates out", () => {
    // Email clients do not reliably support CSS custom properties, so email
    // colour cannot reference :root tokens. Gating lib/email/templates/ would
    // demand a conversion that breaks the emails.
    expect(SCANNED_DIRS).not.toContain("lib");
    const { violations } = scanFixture("lib/email/templates/welcome.ts", `const bg = "#1d4ed8";`);
    expect(violations).toEqual([]);
  });

  it("skips test files, where a colour literal is the assertion", () => {
    const { violations } = scanFixture("components/Seeded.test.tsx", `expect(c).toBe("#1d4ed8");`);
    expect(violations).toEqual([]);
  });
});
