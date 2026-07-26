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
 *
 * Kept byte-identical with house-starter's copy — template and generated app
 * must not drift on this contract.
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

/** Numeric tokens are lengths, not colours — they are correctly bare. */
const NUMERIC_TOKENS = /^--(bp-|touch-target-min)/;

const css = readFileSync(resolve(ROOT, "app/globals.css"), "utf8");

/** Every `--token: value;` declaration in the file, including any inside a
 *  media query (dark mode redefines --link), with comments stripped first. */
function declarations(): Array<{ name: string; value: string }> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => ({
    name: m[1],
    value: m[2].trim(),
  }));
}

describe("design tokens — globals.css format", () => {
  it.each(TOKENS)("--%s is a bare HSL channel triplet everywhere it is declared", (token) => {
    const found = declarations().filter((d) => d.name === `--${token}`);
    expect(found.length, `--${token} is not declared in app/globals.css`).toBeGreaterThan(0);
    for (const d of found) {
      // "<hue> <sat>% <light>%" — hue unitless, both others percentages.
      expect(d.value, `--${token} = ${d.value}`).toMatch(/^-?[\d.]+ [\d.]+% [\d.]+%$/);
    }
  });

  it("no colour token holds a hex value (hex under an hsl() wrapper is invalid CSS)", () => {
    for (const d of declarations()) {
      if (NUMERIC_TOKENS.test(d.name)) continue;
      expect(d.value.startsWith("#"), `${d.name} is hex: ${d.value}`).toBe(false);
    }
  });

  it("no token wraps itself in hsl() (the wrapper belongs in tailwind.config.ts)", () => {
    for (const d of declarations()) {
      expect(d.value.startsWith("hsl("), `${d.name} self-wraps: ${d.value}`).toBe(false);
    }
  });

  it("numeric tokens, where present, stay bare lengths", () => {
    // Generated apps carry the Spec C4 responsive contract (--bp-*,
    // --touch-target-min) emitted by build-design.py; the house-starter
    // template itself does not, so their presence is not asserted here — only
    // that they are never wrapped in hsl() if they exist.
    for (const d of declarations().filter((x) => NUMERIC_TOKENS.test(x.name))) {
      expect(d.value, `${d.name} is not a bare length`).toMatch(/^\d+px$/);
    }
  });

  it("plain-CSS reads of a colour token supply their own hsl() wrapper", () => {
    // A rule outside Tailwind (e.g. :focus-visible reading --primary) must wrap
    // the token itself. A bare var(--primary) there resolves to a channel
    // triplet, which is not a colour, so the declaration is silently dropped.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const token of TOKENS) {
      const uses = withoutComments.matchAll(new RegExp(`(hsl\\()?var\\(--${token}\\)`, "g"));
      for (const m of uses) {
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
    const out = await buildCss('<div class="bg-primary/50"></div>');
    expect(out).toContain(".bg-primary\\/50");
    expect(out).toMatch(/background-color:\s*hsl\(var\(--primary\)\s*\/\s*0\.5\)/);
  });

  it("every token supports an opacity modifier", async () => {
    const markup = TOKENS.map((t) => `<div class="bg-${t}/40"></div>`).join("");
    const out = await buildCss(markup);
    for (const token of TOKENS) {
      expect(out, `bg-${token}/40 emitted no CSS`).toContain(`.bg-${token}\\/40`);
      expect(out).toMatch(new RegExp(`hsl\\(var\\(--${token}\\)\\s*/\\s*0\\.4\\)`));
    }
  });

  it("modifiers work across utility families, not just background", async () => {
    const out = await buildCss(
      '<div class="text-primary/60 border-border/30 ring-accent/20"></div>',
    );
    expect(out).toMatch(/color:\s*hsl\(var\(--primary\)\s*\/\s*0\.6\)/);
    expect(out).toMatch(/border-color:\s*hsl\(var\(--border\)\s*\/\s*0\.3\)/);
    expect(out).toMatch(/hsl\(var\(--accent\)\s*\/\s*0\.2\)/);
  });

  it("opaque utilities still resolve to the plain token", async () => {
    const out = await buildCss('<div class="bg-primary text-text-primary"></div>');
    expect(out).toMatch(/background-color:\s*hsl\(var\(--primary\)/);
    expect(out).toMatch(/color:\s*hsl\(var\(--text-primary\)/);
  });
});
