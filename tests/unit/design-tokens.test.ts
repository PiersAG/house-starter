/**
 * Design-token contract: format, mapping, and measured accessibility.
 *
 * These tests exist because of two silent failures, neither hypothetical.
 *
 * 1. FORMAT. The original scheme stored hex in the tokens and mapped them in
 *    tailwind.config.ts as raw `var(--primary)`. Tailwind cannot inject an
 *    alpha channel into an already-opaque colour value, so every opacity
 *    modifier — bg-primary/50, ring-accent/20 — produced NO CSS AT ALL. Not a
 *    wrong colour: no rule, no warning. `bg-primary/50` rendered with no
 *    background and CI stayed green. The fix is a paired contract — bare HSL
 *    channel triplets in globals.css, hsl(var(--token)) wrappers in the config.
 *    Break either half and colours stop rendering, so both are asserted.
 *
 * 2. CONTRAST. Several tokens carried WCAG claims that were simply wrong —
 *    one documented as "4.60:1 AA-pass" measured 3.74:1, and a status badge
 *    set amber text on a 20% wash of the same amber (1.80:1). Comments cannot
 *    be trusted to stay true, so the ratios are now COMPUTED from the live
 *    token values on every run. These assertions are palette-agnostic: they
 *    check relationships, not specific colours, so they travel to any app
 *    generated from this template and fail if a regenerated palette is
 *    inaccessible.
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
const css = readFileSync(resolve(ROOT, "app/globals.css"), "utf8");

/** Colour tokens mapped flat in the config (no paired foreground). */
const FLAT_TOKENS = [
  "background",
  "foreground",
  "surface",
  "border",
  "input",
  "ring",
  "link",
  "text-primary",
  "text-secondary",
] as const;

/** Colour tokens mapped as { DEFAULT, foreground } — shadcn's shape. */
const PAIRED_TOKENS = [
  "primary",
  "secondary",
  "accent",
  "destructive",
  "muted",
  "card",
  "popover",
] as const;

const COLOUR_TOKENS = [
  ...FLAT_TOKENS,
  ...PAIRED_TOKENS,
  ...PAIRED_TOKENS.map((t) => `${t}-foreground`),
];

/** Non-colour tokens: lengths, never hsl()-wrapped. */
const LENGTH_TOKENS = /^--(bp-|touch-target-min|radius)/;

const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `--token: value;` declaration, including any inside a media query. */
function declarations(): Array<{ name: string; value: string }> {
  return [...withoutComments.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => ({
    name: m[1],
    value: m[2].trim(),
  }));
}

function tokenValue(name: string): string {
  const found = declarations().filter((d) => d.name === `--${name}`);
  if (found.length === 0) throw new Error(`--${name} is not declared in app/globals.css`);
  return found[0].value;
}

// ── Colour maths (WCAG 2.x, sRGB relative luminance) ────────────────────────

function tripletToRgb(triplet: string): [number, number, number] {
  const [h, s, l] = triplet.replace(/%/g, "").split(/\s+/).map(Number);
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg];
  return [r, g, b].map((v) => Math.round((v + m) * 255)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(aToken: string, bToken: string): number {
  const [l1, l2] = [tokenValue(aToken), tokenValue(bToken)]
    .map((t) => luminance(tripletToRgb(t)))
    .sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Round to 2dp for readable failure messages. */
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Run the real Tailwind config over markup and return the generated CSS. */
async function buildCss(markup: string): Promise<string> {
  const result = await postcss([
    tailwindcss({ ...(config as Config), content: [{ raw: markup, extension: "html" }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

// ── Format ──────────────────────────────────────────────────────────────────

describe("design tokens — globals.css format", () => {
  it.each(COLOUR_TOKENS)("--%s is a bare HSL channel triplet everywhere declared", (token) => {
    const found = declarations().filter((d) => d.name === `--${token}`);
    expect(found.length, `--${token} is not declared in app/globals.css`).toBeGreaterThan(0);
    for (const d of found) {
      expect(d.value, `--${token} = ${d.value}`).toMatch(/^-?[\d.]+ [\d.]+% [\d.]+%$/);
    }
  });

  it("no colour token holds a hex value (hex under an hsl() wrapper is invalid CSS)", () => {
    for (const d of declarations()) {
      if (LENGTH_TOKENS.test(d.name)) continue;
      expect(d.value.startsWith("#"), `${d.name} is hex: ${d.value}`).toBe(false);
    }
  });

  it("no token wraps itself in hsl() (the wrapper belongs in tailwind.config.ts)", () => {
    for (const d of declarations()) {
      expect(d.value.startsWith("hsl("), `${d.name} self-wraps: ${d.value}`).toBe(false);
    }
  });

  it("length tokens stay bare lengths — --radius, and the Spec C4 responsive set", () => {
    for (const d of declarations().filter((x) => LENGTH_TOKENS.test(x.name))) {
      expect(d.value, `${d.name} is not a bare length`).toMatch(/^[\d.]+(px|rem)$/);
    }
    expect(tokenValue("radius")).toMatch(/^[\d.]+rem$/);
  });

  it("plain-CSS reads of a colour token supply their own hsl() wrapper", () => {
    for (const token of COLOUR_TOKENS) {
      for (const m of withoutComments.matchAll(new RegExp(`(hsl\\()?var\\(--${token}\\)`, "g"))) {
        expect(m[1], `var(--${token}) is read in plain CSS without an hsl() wrapper`).toBe("hsl(");
      }
    }
  });
});

// ── Config mapping ──────────────────────────────────────────────────────────

describe("design tokens — tailwind.config.ts mapping", () => {
  const colors = (config.theme?.extend?.colors ?? {}) as Record<string, unknown>;

  it.each(FLAT_TOKENS)("%s maps flat to hsl(var(--token))", (token) => {
    expect(colors[token]).toBe(`hsl(var(--${token}))`);
  });

  it.each(PAIRED_TOKENS)("%s maps as { DEFAULT, foreground }", (token) => {
    expect(colors[token]).toEqual({
      DEFAULT: `hsl(var(--${token}))`,
      foreground: `hsl(var(--${token}-foreground))`,
    });
  });

  it("every mapped colour resolves to a token that globals.css actually defines", () => {
    const declared = new Set(declarations().map((d) => d.name));
    const refs = JSON.stringify(colors).matchAll(/var\((--[a-z-]+)\)/g);
    for (const [, name] of refs) {
      expect(declared.has(name), `tailwind.config.ts references ${name}, undefined in globals.css`).toBe(true);
    }
  });

  it("--radius drives the border-radius scale and is used bare", () => {
    const radii = (config.theme?.extend?.borderRadius ?? {}) as Record<string, string>;
    expect(radii.lg).toBe("var(--radius)");
    for (const value of Object.values(radii)) {
      expect(value, `${value} must not be hsl()-wrapped`).not.toContain("hsl(");
    }
  });
});

// ── Opacity modifiers (the regression that started this) ────────────────────

describe("design tokens — opacity modifiers emit real CSS", () => {
  it("bg-primary/50 emits a rule carrying the alpha channel", async () => {
    const out = await buildCss('<div class="bg-primary/50"></div>');
    expect(out).toContain(".bg-primary\\/50");
    expect(out).toMatch(/background-color:\s*hsl\(var\(--primary\)\s*\/\s*0\.5\)/);
  });

  it("every colour token supports an opacity modifier", async () => {
    const utilities = [...FLAT_TOKENS, ...PAIRED_TOKENS];
    const out = await buildCss(utilities.map((t) => `<div class="bg-${t}/40"></div>`).join(""));
    for (const token of utilities) {
      expect(out, `bg-${token}/40 emitted no CSS`).toContain(`.bg-${token}\\/40`);
      expect(out).toMatch(new RegExp(`hsl\\(var\\(--${token}\\)\\s*/\\s*0\\.4\\)`));
    }
  });

  it("paired foreground utilities resolve too", async () => {
    const out = await buildCss(
      PAIRED_TOKENS.map((t) => `<div class="text-${t}-foreground"></div>`).join(""),
    );
    for (const token of PAIRED_TOKENS) {
      expect(out).toMatch(new RegExp(`hsl\\(var\\(--${token}-foreground\\)`));
    }
  });

  it("modifiers work across utility families, not just background", async () => {
    const out = await buildCss('<div class="text-primary/60 border-border/30 ring-accent/20"></div>');
    expect(out).toMatch(/color:\s*hsl\(var\(--primary\)\s*\/\s*0\.6\)/);
    expect(out).toMatch(/border-color:\s*hsl\(var\(--border\)\s*\/\s*0\.3\)/);
    expect(out).toMatch(/hsl\(var\(--accent\)\s*\/\s*0\.2\)/);
  });
});

// ── Entry directives (the regression that cost a build) ────────────────

/**
 * Compile the app's REAL entry stylesheet over `markup`.
 *
 * This is deliberately NOT buildCss() above. That helper feeds Tailwind a
 * synthetic "@tailwind utilities;" input, so it proves the CONFIG is right
 * while saying nothing about whether app/globals.css ever invokes it — and
 * that is exactly the blind spot these tests exist to close. Every assertion
 * in this file passed against a globals.css that had been overwritten with a
 * bare :root block and no directives at all.
 */
async function buildFromGlobals(markup: string): Promise<string> {
  const result = await postcss([
    tailwindcss({
      ...(config as Config),
      content: [{ raw: markup, extension: "html" }],
    }),
  ]).process(css, { from: undefined });
  return result.css;
}

/** WCAG 2.2 SC 2.5.8 target-size (minimum), in CSS px. */
const TARGET_SIZE_MIN_PX = 24;

/**
 * The sizing utilities /login's interactive targets rely on to clear that
 * floor, as [class, the property it must set]. Sourced from app/login/
 * LoginForm.tsx: the submit button (min-h-11), the show/hide-password toggle
 * (h-8 w-8) and the remember-me checkbox (h-6 w-6, exactly on the floor).
 */
const TARGET_SIZING: ReadonlyArray<readonly [string, string]> = [
  ["min-h-11", "min-height"],
  ["h-8", "height"],
  ["w-8", "width"],
  ["h-6", "height"],
  ["w-6", "width"],
];

/** "2.75rem" -> 44. Returns NaN for anything not a rem/px length. */
function lengthToPx(value: string): number {
  const m = /^([\d.]+)(rem|px)$/.exec(value.trim());
  if (!m) return NaN;
  return m[2] === "rem" ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
}

describe("design tokens — globals.css actually invokes Tailwind", () => {
  /**
   * WHY THIS IS NOT PARANOIA: agents/build-init.py overwrites app/globals.css
   * with build-design.py's output for every generated app. An artefact
   * generated before that emitter learned to write the directives produces a
   * stylesheet with tokens but no utilities. Nothing errors. Tailwind emits no
   * h-*, w-*, min-h-*, px-* or w-full rule at all, every control collapses to
   * its intrinsic unstyled size, and the first thing that notices is the axe
   * target-size assertion in tests/e2e/smoke.spec.ts — which reports a
   * 56.8x21px submit button and reads as a design bug, not a build one.
   * K9Coach v0 burned its entire UI-phase budget on that misreading.
   */
  it("declares the three @tailwind entry directives", () => {
    for (const layer of ["base", "components", "utilities"]) {
      expect(
        new RegExp(`^@tailwind\\s+${layer};`, "m").test(css),
        `app/globals.css is missing "@tailwind ${layer};" — without it Tailwind ` +
          `emits no ${layer} CSS and every utility class silently does nothing`,
      ).toBe(true);
    }
  });

  it("puts them ahead of any custom rule, so custom CSS layers on top", () => {
    const firstRule = withoutComments.search(/^[^@\s][^{]*\{/m);
    const lastDirective = withoutComments.lastIndexOf("@tailwind");
    expect(
      lastDirective,
      "no @tailwind directive found",
    ).toBeGreaterThanOrEqual(0);
    if (firstRule !== -1) {
      expect(
        lastDirective,
        "a custom rule precedes the @tailwind directives; Tailwind's output " +
          "would then override it instead of the other way round",
      ).toBeLessThan(firstRule);
    }
  });

  it.each(TARGET_SIZING)(
    "%s emits a real rule and clears the 24px target-size floor",
    async (cls, property) => {
      const out = await buildFromGlobals(`<div class="${cls}"></div>`);
      const rule = new RegExp(
        `\\.${cls}\\s*\\{\\s*${property}:\\s*([^;]+);`,
      ).exec(out);
      expect(
        rule,
        `.${cls} emitted NO CSS from the app's own globals.css — the control ` +
          `it sizes will fall back to its intrinsic size and fail axe target-size`,
      ).not.toBeNull();
      const px = lengthToPx(rule![1]);
      expect(
        px,
        `.${cls} sets ${property}: ${rule![1]} (${px}px), below the ` +
          `${TARGET_SIZE_MIN_PX}px WCAG 2.2 target-size floor`,
      ).toBeGreaterThanOrEqual(TARGET_SIZE_MIN_PX);
    },
  );

  it("the login form's own markup still carries those sizing classes", () => {
    const form = readFileSync(resolve(ROOT, "app/login/LoginForm.tsx"), "utf8");
    for (const [cls] of TARGET_SIZING) {
      expect(
        new RegExp(`\\b${cls}\\b`).test(form),
        `LoginForm.tsx no longer uses ${cls}; either the target shrank below ` +
          `the 24px floor or this contract needs updating alongside it`,
      ).toBe(true);
    }
  });
});

// ── Measured accessibility ──────────────────────────────────────────────────

describe("design tokens — WCAG contrast, computed from the live values", () => {
  // 4.5:1 — normal text (WCAG 1.4.3). Every foreground on its own surface.
  const TEXT_PAIRS: Array<[string, string]> = [
    ["foreground", "background"],
    ["text-primary", "background"],
    ["text-secondary", "background"],
    ...PAIRED_TOKENS.map((t) => [`${t}-foreground`, t] as [string, string]),
  ];

  it.each(TEXT_PAIRS)("--%s on --%s reaches 4.5:1 (normal text)", (fg, bg) => {
    const ratio = contrast(fg, bg);
    expect(ratio, `--${fg} on --${bg} is ${r2(ratio)}:1, below the 4.5:1 AA floor`).toBeGreaterThanOrEqual(4.5);
  });

  // 3:1 — non-text UI components and their boundaries (WCAG 1.4.11).
  const UI_PAIRS: Array<[string, string]> = [
    ["input", "background"],
    ["input", "surface"],
    ["ring", "background"],
  ];

  it.each(UI_PAIRS)("--%s against --%s reaches 3:1 (non-text UI)", (fg, bg) => {
    const ratio = contrast(fg, bg);
    expect(ratio, `--${fg} on --${bg} is ${r2(ratio)}:1, below the 3:1 floor`).toBeGreaterThanOrEqual(3);
  });

  it("--input is not merely an alias of --border", () => {
    // --border draws decorative dividers, where 1.4.11 does not apply, and is
    // typically far below 3:1. --input draws the boundary of an active control
    // and must clear it. Aliasing them ships inaccessible form fields.
    expect(tokenValue("input")).not.toBe(tokenValue("border"));
  });
});
