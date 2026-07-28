/**
 * Homepage content contract (card 2.3.7).
 *
 * app/page.tsx does `homepage as HomepageContent`. A cast is a promise to the
 * compiler, not a check — TypeScript never reads the JSON's contents, so a
 * malformed block or a block type the renderer has no case for would pass
 * `tsc`, pass the build, and fail in front of a customer with a silently
 * missing section. This file is the actual gate: it validates the SHIPPED
 * content/homepage.json, and it pins that bad input is rejected.
 *
 * It also pins the token rule. Marketing blocks were adapted from HyperUI and
 * Meraki UI, whose sources are full of palette literals (text-gray-900,
 * ring-indigo-600, bg-blue-500). Any one of those surviving the adaptation
 * would paint a colour the app's palette does not control — which is invisible
 * in review and obvious on a customer's screen.
 *
 * Kept byte-identical between house-starter and every generated app.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import type { Config } from "tailwindcss";

import config from "../../tailwind.config";
import { validateHomepage } from "../../components/homepage/validate";
import { HOMEPAGE_SECTION_TYPES } from "../../components/homepage/types";
import { HeroSplit } from "../../components/homepage/HeroSplit";
import { Testimonials } from "../../components/homepage/Testimonials";
import { Pricing } from "../../components/homepage/Pricing";
import { FAQ } from "../../components/homepage/FAQ";

const ROOT = resolve(__dirname, "../..");
const shipped = JSON.parse(
  readFileSync(resolve(ROOT, "content/homepage.json"), "utf8"),
);

/** A minimal, valid legacy homepage — the pre-2.3.7 shape. */
const LEGACY = {
  product: "Example",
  hero: {
    heading: "A heading",
    subheading: "A subheading",
    cta: { label: "Get started", href: "/signup" },
  },
  features: [{ title: "One", description: "First" }],
  cta: {
    heading: "Ready?",
    subheading: "Go",
    label: "Start",
    href: "/signup",
  },
  footer: { tagline: "Example — a tagline." },
};

const withSections = (sections: unknown) => ({ ...LEGACY, sections });

// ── The shipped file ────────────────────────────────────────────────────────

describe("content/homepage.json as shipped", () => {
  it("validates", () => {
    const result = validateHomepage(shipped);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("every section it composes is a block the renderer handles", () => {
    for (const section of shipped.sections ?? []) {
      expect(HOMEPAGE_SECTION_TYPES).toContain(section.type);
    }
  });

  it("is not the template placeholder", () => {
    // The failure this card was raised on: an app shipping a landing page that
    // still says "replace this".
    const text = JSON.stringify(shipped).toLowerCase();
    expect(text).not.toContain("replace this");
    expect(text).not.toContain("lorem ipsum");
  });
});

// ── Back-compatibility ──────────────────────────────────────────────────────

describe("back-compatibility", () => {
  it("a homepage.json with no sections key is still valid", () => {
    expect(validateHomepage(LEGACY).ok).toBe(true);
  });
});

// ── Rejection: the gate that stops a broken homepage shipping ───────────────

describe("validateHomepage rejects", () => {
  it("an unknown block type, naming what was expected", () => {
    const result = validateHomepage(
      withSections([{ type: "carousel", content: {} }]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(
      /sections\[0\]\.type "carousel" is not a known block/,
    );
  });

  it("a section with no content", () => {
    const result = validateHomepage(withSections([{ type: "faq" }]));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/sections\[0\]\.content is required/);
  });

  it("an empty sections array (renders a blank page while looking deliberate)", () => {
    const result = validateHomepage(withSections([]));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/must not be empty/);
  });

  it("a pricing plan with no price", () => {
    const result = validateHomepage(
      withSections([
        {
          type: "pricing",
          content: {
            heading: "Pricing",
            plans: [
              {
                name: "Pro",
                features: ["A"],
                cta: { label: "Go", href: "/signup" },
              },
            ],
          },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/plans\[0\]\.price/);
  });

  it("a testimonial with no attributable name", () => {
    const result = validateHomepage(
      withSections([
        {
          type: "testimonials",
          content: { heading: "Praise", items: [{ quote: "It is good" }] },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/items\[0\]\.name/);
  });

  it("an FAQ item with a question but no answer", () => {
    const result = validateHomepage(
      withSections([
        {
          type: "faq",
          content: { heading: "FAQ", items: [{ question: "Why?" }] },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/items\[0\]\.answer/);
  });

  it("a CTA href that is not a route", () => {
    const result = validateHomepage({
      ...LEGACY,
      cta: { ...LEGACY.cta, href: "https://example.com" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/must be a route starting with/);
  });

  it("a non-object payload", () => {
    expect(validateHomepage("nope").ok).toBe(false);
    expect(validateHomepage(null).ok).toBe(false);
  });
});

// ── Tokens, not palette literals ────────────────────────────────────────────

const BLOCK_FILES = readdirSync(resolve(ROOT, "components/homepage")).filter(
  (f) => f.endsWith(".tsx"),
);

describe("marketing blocks render through design tokens", () => {
  it.each(BLOCK_FILES)("%s contains no hardcoded colour", (file) => {
    // Scans the WHOLE file, COMMENTS INCLUDED. This is not pedantry: Tailwind's
    // content scanner reads these files as raw text, so a palette class named
    // in a provenance comment is treated as a real usage and emits a dead,
    // hardcoded-colour rule into every generated app's production stylesheet.
    // Measured, not assumed — the first draft of these headers named the
    // literals they had replaced, and .text-gray-900, .text-gray-700 and
    // .text-indigo-700 duly appeared in K9Coach's served CSS.
    const code = readFileSync(resolve(ROOT, "components/homepage", file), "utf8");
    expect(code, `${file} contains a hex colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(
      code,
      `${file} contains a Tailwind palette literal (use a token)`,
    ).not.toMatch(
      /\b(?:bg|text|border|ring|divide|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\b/,
    );
  });
});

// ── Proof the token classes actually resolve to the app's palette ───────────

async function buildCss(markup: string): Promise<string> {
  const result = await postcss([
    tailwindcss({
      ...(config as Config),
      content: [{ raw: markup, extension: "html" }],
    }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

describe("token-driven colour resolves for every new block", () => {
  const rendered: Record<string, string> = {
    HeroSplit: renderToStaticMarkup(
      HeroSplit({
        hero: {
          eyebrow: "Eyebrow",
          heading: "Heading",
          subheading: "Sub",
          cta: { label: "Go", href: "/signup" },
          secondaryCta: { label: "More", href: "/contact" },
          trustLine: "No card required.",
        },
      }),
    ),
    Testimonials: renderToStaticMarkup(
      Testimonials({
        testimonials: {
          heading: "Praise",
          items: [{ quote: "Good", name: "A Person", role: "A role" }],
        },
      }),
    ),
    Pricing: renderToStaticMarkup(
      Pricing({
        pricing: {
          heading: "Pricing",
          plans: [
            {
              name: "Pro",
              price: "£29",
              period: "/month",
              features: ["A", "B"],
              cta: { label: "Go", href: "/signup" },
              featured: true,
            },
          ],
        },
      }),
    ),
    FAQ: renderToStaticMarkup(
      FAQ({ faq: { heading: "FAQ", items: [{ question: "Q?", answer: "A." }] } }),
    ),
  };

  it.each(Object.keys(rendered))("%s emits CSS wired to a CSS variable", async (name) => {
    const css = await buildCss(rendered[name]);
    // The paired contract from design-tokens.test.ts: every colour utility the
    // block uses must resolve through hsl(var(--token)), never a literal.
    expect(css).toMatch(/hsl\(var\(--[a-z-]+\)/);
    expect(css).toContain("--text-primary");
  });

  it("the featured pricing plan is highlighted in the APP's primary, not HyperUI's indigo", async () => {
    const css = await buildCss(rendered.Pricing);
    expect(rendered.Pricing).toContain("ring-primary");
    expect(css).toMatch(/\.ring-primary\s*\{[^}]*hsl\(var\(--primary\)/);
    expect(css).not.toMatch(/indigo|#4f46e5/i);
  });

  it("the FAQ ships no client JavaScript (native details/summary)", () => {
    expect(rendered.FAQ).toContain("<details");
    expect(rendered.FAQ).toContain("<summary");
    expect(rendered.FAQ).not.toContain("onclick");
  });
});
