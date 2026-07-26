/**
 * Design-token format contract.
 *
 * These tests exist because of a silent failure, not a hypothetical one. The
 * previous scheme stored hex in the tokens and mapped them in tailwind.config.ts
 * as raw `var(--primary)`. Tailwind cannot inject an alpha channel into an
 * already-opaque colour value, so every opacity modifier — bg-primary/50,
 * ring-accent/20 — produced NO CSS AT ALL. Not a wrong colour: no rule, no
 * warning, nothing. Any component written with `bg-primary/50` rendered with no
 * background whatsoever and CI stayed green.
 *
 * The fix is a paired contract: bare HSL channel triplets in globals.css,
 * hsl(var(--token)) wrappers in tailwind.config.ts. Break either half and the
 * colours stop rendering entirely, so both halves are asserted here.
 *
 * The Tailwind build is driven through PostCSS against the REAL
 * tailwind.config.ts, so these tests fail if that config regresses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import type { Config } from "tailwindcss";

import config from "../../tailwind.config";

const ROOT = resolve(__dirname, "../..");

/** Run the real Tailwind config over a snippet of markup and return the CSS. */
async function buildCss(markup: string): Promise<string> {
  const result = await postcss([
    tailwindcss({ ...(config as Config), content: [{ raw: markup, extension: "html" }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

const TOKENS = [
  "primary",
  "secondary",
  "background",
  "surface",
  "text-primary",
  "text-secondary",
  "border",
  "accent",
  "destructive",
  "link",
] as const;

describe("design tokens — globals.css format", () => {
  const css = readFileSync(resolve(ROOT, "app/globals.css"), "utf8");
  const root = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));

  it.each(TOKENS)("--%s is a bare HSL channel triplet", (token) => {
    const match = root.match(new RegExp(`--${token}:\\s*([^;]+);`));
    expect(match, `--${token} is missing from :root in app/globals.css`).not.toBeNull();
    const value = match![1].trim();
    // "<hue> <sat>% <light>%" — hue unitless, both others percentages.
    expect(value).toMatch(/^-?[\d.]+ [\d.]+% [\d.]+%$/);
  });

  it("no token holds a hex value (hex under an hsl() wrapper is invalid CSS)", () => {
    expect(root).not.toMatch(/--[a-z-]+:\s*#/);
  });

  it("no token wraps itself in hsl() (the wrapper belongs in tailwind.config.ts)", () => {
    expect(root).not.toMatch(/--[a-z-]+:\s*hsl\(/);
  });

  it("plain-CSS reads of a colour token supply their own hsl() wrapper", () => {
    // Rules outside Tailwind (e.g. :focus-visible reading --primary) must wrap
    // the token themselves. A bare var(--primary) there resolves to a channel
    // triplet, which is not a colour, so the declaration is silently dropped.
    // Scope: the file body after :root, and colour tokens only — the numeric
    // tokens generated apps carry (--bp-*, --touch-target-min) are correctly bare.
    const body = css.slice(css.indexOf("}", css.indexOf(":root")) + 1);
    for (const token of TOKENS) {
      for (const m of body.matchAll(new RegExp(`(hsl\\()?var\\(--${token}\\)`, "g"))) {
        expect(m[1], `var(--${token}) is read in plain CSS without an hsl() wrapper`).toBe(
          "hsl(",
        );
      }
    }
  });
});

describe("design tokens — tailwind.config.ts mapping", () => {
  const colors = (config.theme?.extend?.colors ?? {}) as Record<string, string>;

  it.each(TOKENS)("%s is mapped as hsl(var(--token))", (token) => {
    expect(colors[token]).toBe(`hsl(var(--${token}))`);
  });

  it("maps exactly the ten tokens globals.css defines — no orphans either way", () => {
    expect(Object.keys(colors).sort()).toEqual([...TOKENS].sort());
  });
});

describe("design tokens — opacity modifiers emit real CSS (the regression that started this)", () => {
  it("bg-primary/50 emits a rule carrying the alpha channel", async () => {
    const css = await buildCss('<div class="bg-primary/50"></div>');
    expect(css).toContain(".bg-primary\\/50");
    expect(css).toMatch(/background-color:\s*hsl\(var\(--primary\)\s*\/\s*0\.5\)/);
  });

  it("every token supports an opacity modifier", async () => {
    const markup = TOKENS.map((t) => `<div class="bg-${t}/40"></div>`).join("");
    const css = await buildCss(markup);
    for (const token of TOKENS) {
      expect(css, `bg-${token}/40 emitted no CSS`).toContain(`.bg-${token}\\/40`);
      expect(css).toMatch(new RegExp(`hsl\\(var\\(--${token}\\)\\s*/\\s*0\\.4\\)`));
    }
  });

  it("modifiers work across utility families, not just background", async () => {
    const css = await buildCss(
      '<div class="text-primary/60 border-border/30 ring-accent/20"></div>',
    );
    expect(css).toMatch(/color:\s*hsl\(var\(--primary\)\s*\/\s*0\.6\)/);
    expect(css).toMatch(/border-color:\s*hsl\(var\(--border\)\s*\/\s*0\.3\)/);
    expect(css).toMatch(/hsl\(var\(--accent\)\s*\/\s*0\.2\)/);
  });

  it("opaque utilities still resolve to the plain token", async () => {
    const css = await buildCss('<div class="bg-primary text-text-primary"></div>');
    expect(css).toMatch(/background-color:\s*hsl\(var\(--primary\)/);
    expect(css).toMatch(/color:\s*hsl\(var\(--text-primary\)/);
  });
});
