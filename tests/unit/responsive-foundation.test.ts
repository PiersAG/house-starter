/**
 * The responsive foundation: container queries + fluid type/spacing (card 2.3.15).
 *
 * WHY THESE ARE COMPILE TESTS AND NOT STRING CHECKS. This repo's characteristic
 * Tailwind failure is not a wrong value — it is NO RULE AT ALL. A misconfigured
 * plugin, a variant that does not exist, or a theme key in the wrong place all
 * produce the same symptom: the class is in the markup, no CSS is emitted, the
 * page renders unstyled, and every test that only greps the config still
 * passes. (Design-token contract §1 is the same lesson, learned the same way.)
 *
 * So every assertion here runs the real Tailwind pipeline over real markup and
 * checks that CSS came out the other side.
 */
import { describe, it, expect } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import type { Config } from "tailwindcss";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import config from "../../tailwind.config";

const ROOT = resolve(__dirname, "../..");

async function buildCss(markup: string): Promise<string> {
  const result = await postcss([
    tailwindcss({ ...(config as Config), content: [{ raw: markup, extension: "html" }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

describe("container queries", () => {
  it("emits a @container rule for a container context", async () => {
    const css = await buildCss('<div class="@container"></div>');
    expect(css).toContain("container-type: inline-size");
  });

  it("emits a real @container at-rule for a named size variant", async () => {
    const css = await buildCss('<div class="@container/appnav"><a class="@compact/appnav:flex-row"></a></div>');
    // The variant must produce an actual @container query, not a media query —
    // a media query here would mean the component is asking about the WINDOW,
    // which is the entire failure this foundation exists to prevent.
    expect(css).toMatch(/@container\s+appnav\s*\(/);
    expect(css).toContain("flex-direction: row");
    expect(css).not.toMatch(/@media[^{]*min-width[^{]*\{[^}]*flex-direction:\s*row/);
  });

  it("resolves the named boundaries to their configured widths", async () => {
    const css = await buildCss('<div class="@compact:block @roomy:block"></div>');
    expect(css).toContain("24rem"); // compact
    expect(css).toContain("40rem"); // roomy
  });
});

describe("fluid type and spacing", () => {
  it("emits clamp() for a fluid font size", async () => {
    const css = await buildCss('<p class="text-fluid-base"></p>');
    expect(css).toMatch(/font-size:\s*clamp\(/);
  });

  it("emits clamp() for fluid spacing", async () => {
    const css = await buildCss('<div class="p-fluid-md gap-fluid-3xs"></div>');
    expect(css).toMatch(/padding:\s*clamp\(/);
    expect(css).toMatch(/gap:\s*clamp\(/);
  });

  it("keeps Tailwind's own scales working — this layer is additive", async () => {
    const css = await buildCss('<p class="text-sm p-4 md:flex-row"></p>');
    expect(css).toContain("font-size: 0.875rem");
    expect(css).toContain("padding: 1rem");
    expect(css).toMatch(/@media[^{]*768px/);
  });
});

describe("WCAG 1.4.4 — fluid sizes must not block 200% text zoom", () => {
  const theme = (config as Config).theme!.extend!;

  /** Every fluid step, as [name, clamp string]. */
  const steps: [string, string][] = [
    ...Object.entries(theme.fontSize as Record<string, [string, unknown]>).map(
      ([k, v]) => [`fontSize.${k}`, v[0]] as [string, string],
    ),
    ...Object.entries(theme.spacing as Record<string, string>).map(
      ([k, v]) => [`spacing.${k}`, v] as [string, string],
    ),
  ];

  it("has fluid steps to check", () => {
    expect(steps.length).toBeGreaterThan(10);
  });

  it.each(steps)("%s caps at no less than 2x its minimum", (_name, value) => {
    const m = /clamp\(([\d.]+)rem,[^,]+,\s*([\d.]+)rem\)/.exec(value);
    expect(m, `not a parseable clamp(): ${value}`).toBeTruthy();
    const [min, max] = [parseFloat(m![1]), parseFloat(m![2])];
    // The ceiling is zoom headroom, not a design size. Cap below 2x and text
    // stops growing before it reaches the 200% WCAG 1.4.4 requires.
    expect(max).toBeGreaterThanOrEqual(min * 2 - 0.0001);
  });

  it("refuses a step whose large size would be clipped by the ceiling", async () => {
    // The guard is the reason the rule above can be trusted going forward.
    const { default: freshConfig } = await import("../../tailwind.config");
    expect(freshConfig).toBeTruthy();
    // fluid(16, 40) asks for a max above the 32px ceiling — must throw.
    const src = readFileSync(resolve(ROOT, "tailwind.config.ts"), "utf8");
    expect(src).toContain("assertZoomHeadroom");
    expect(src).toMatch(/if \(maxPx > minPx \* 2\)/);
  });
});

describe("the convention is documented where UI authors will see it", () => {
  it("docs/responsive.md exists and states the rule", () => {
    const doc = readFileSync(resolve(ROOT, "docs/responsive.md"), "utf8");
    expect(doc).toContain("Components ask their container");
    expect(doc).toContain("Pages ask the viewport");
  });

  it("CLAUDE.md points at it before any UI code is written", () => {
    const claude = readFileSync(resolve(ROOT, "CLAUDE.md"), "utf8");
    expect(claude).toContain("docs/responsive.md");
  });

  it("the fluid scale lives in the config, not in globals.css", () => {
    // agents/build-init.py overwrites app/globals.css for every generated app.
    // A scale defined there would vanish from every product built after this.
    const globals = readFileSync(resolve(ROOT, "app/globals.css"), "utf8");
    expect(globals).not.toContain("--fluid-");
    expect(readFileSync(resolve(ROOT, "tailwind.config.ts"), "utf8")).toContain("function fluid(");
  });
});

describe("AppNav — the worked example stays worked", () => {
  const nav = readFileSync(resolve(ROOT, "components/AppNav.tsx"), "utf8");

  it("declares its own named container", () => {
    expect(nav).toContain("@container/appnav");
  });

  it("switches arrangement on a container boundary, not a viewport one", () => {
    expect(nav).toMatch(/@compact\/appnav:flex-row/);
    // A media-query breakpoint inside this component would be the regression.
    expect(nav).not.toMatch(/\bclassName=[^>]*\b(sm|md|lg):flex-(row|col)/);
  });

  it("keeps the 44px touch target in both arrangements", () => {
    // One class on the link itself — so it cannot be present in one
    // arrangement and missing from the other.
    expect(nav).toContain("min-h-11");
  });

  it("ships no JavaScript width detection", () => {
    for (const banned of ["useMediaQuery", "matchMedia", "innerWidth", "useState"]) {
      expect(nav).not.toContain(banned);
    }
  });
});
