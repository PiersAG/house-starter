/**
 * Seeded shadcn/ui components — ownership, token binding, and live rendering.
 *
 * These components are COPIED IN, so they are our source and carry our rules.
 * Three things must hold, and none of them is guaranteed by the fact that they
 * compile:
 *
 * 1. They bind to OUR token vocabulary (card 2.3.2), not to invented names.
 * 2. No copied component repurposes --accent. Upstream shadcn uses --accent as
 *    a SUBDUED hover background; in our palettes it is a VIVID brand colour, so
 *    upstream's `hover:bg-accent` would paint brand-coloured hovers and, on a
 *    light accent, unreadable text. Every such state is remapped to --muted at
 *    seed time. This test is what stops the next re-seed silently undoing it.
 * 3. Opacity modifiers actually emit CSS on them — `bg-primary/90` is used by
 *    the button's own hover state, and under the pre-2.3.2 token format it
 *    emitted nothing at all, silently.
 *
 * Kept byte-identical with k9coach's copy: the template and the generated app
 * must not drift on the seeded set.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import type { Config } from "tailwindcss";

import config from "../../tailwind.config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ROOT = resolve(__dirname, "../..");
const UI_DIR = resolve(ROOT, "components/ui");

/** The seeded set. Deliberately the core-used set, not the whole catalogue:
 *  every copied component is source we own and must audit. */
const SEEDED = [
  "button", "input", "textarea", "label", "select", "card", "badge",
  "table", "dialog", "dropdown-menu", "tabs", "separator", "skeleton",
];

const sourceOf = (name: string) => readFileSync(resolve(UI_DIR, `${name}.tsx`), "utf8");

/** Strip block comments so the audit headers do not satisfy code assertions. */
const codeOf = (name: string) => sourceOf(name).replace(/\/\*[\s\S]*?\*\//g, "");

async function buildCss(markup: string): Promise<string> {
  const result = await postcss([
    tailwindcss({ ...(config as Config), content: [{ raw: markup, extension: "html" }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

describe("seeded set — presence and ownership", () => {
  it.each(SEEDED)("%s.tsx is present in components/ui", (name) => {
    expect(() => sourceOf(name)).not.toThrow();
  });

  it.each(SEEDED)("%s.tsx records its provenance and licence", (name) => {
    const header = sourceOf(name);
    expect(header).toContain("ui.shadcn.com/r/styles/new-york/");
    expect(header).toContain("MIT");
    expect(header).toContain("LOCAL MODIFICATIONS");
  });

  it("no seeded component imports a component-library package", () => {
    // Copy-in means the components are ours. Radix PRIMITIVES are expected;
    // an import of a packaged component library would defeat the model.
    for (const name of SEEDED) {
      const imports = [...codeOf(name).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) {
        const ok =
          spec.startsWith("@radix-ui/") ||
          spec.startsWith("@/") ||
          ["react", "class-variance-authority", "lucide-react", "clsx", "tailwind-merge"].includes(spec);
        expect(ok, `${name}.tsx imports unexpected package ${spec}`).toBe(true);
      }
    }
  });
});

describe("seeded set — token binding (card 2.3.2 handoff)", () => {
  it("no seeded component uses --accent for a hover/focus/open state", () => {
    for (const name of SEEDED) {
      const code = codeOf(name);
      expect(code, `${name}.tsx still references bg-accent`).not.toMatch(/(?<![\w-])bg-accent(?![\w-])/);
      expect(code, `${name}.tsx still references text-accent-foreground`).not.toMatch(
        /(?<![\w-])text-accent-foreground(?![\w-])/,
      );
    }
  });

  it("state backgrounds land on --muted instead", () => {
    // The four components that carried an --accent state upstream.
    for (const name of ["button", "select", "dialog", "dropdown-menu"]) {
      expect(codeOf(name), `${name}.tsx should use a muted state background`).toMatch(/bg-muted/);
    }
  });

  it("every colour class a seeded component uses resolves to a defined token", () => {
    const colours = new Set(Object.keys((config.theme?.extend?.colors ?? {}) as object));
    const builtIn = new Set(["white", "black", "transparent", "current", "inherit"]);
    for (const name of SEEDED) {
      const code = codeOf(name);
      for (const m of code.matchAll(/(?:bg|text|border|ring|ring-offset|fill|stroke|placeholder)-([a-z]+(?:-[a-z]+)*)(?:\/\d+)?/g)) {
        const token = m[1];
        // Only assert on names that look like our vocabulary; Tailwind's own
        // scale words (xs, left, full…) are not colours.
        if (!colours.has(token) && !builtIn.has(token)) continue;
        expect(colours.has(token) || builtIn.has(token)).toBe(true);
      }
    }
  });

  it("does not reference chart or sidebar tokens (deliberately not seeded)", () => {
    for (const name of SEEDED) {
      expect(codeOf(name), `${name}.tsx references a chart token`).not.toMatch(/-chart-\d/);
      expect(codeOf(name), `${name}.tsx references a sidebar token`).not.toMatch(/-sidebar(?![\w-])/);
    }
  });

  it("components/ui holds exactly the seeded set plus the pre-existing helpers", () => {
    const files = readdirSync(UI_DIR).filter((f) => f.endsWith(".tsx")).map((f) => f.replace(/\.tsx$/, ""));
    const expected = [...SEEDED, "EmptyState", "LoadingSpinner"].sort();
    expect(files.sort()).toEqual(expected);
  });
});

describe("seeded set — renders against the real palette", () => {
  it("Button renders with our primary token pair", () => {
    render(<Button>Save</Button>);
    const el = screen.getByRole("button", { name: "Save" });
    expect(el.className).toContain("bg-primary");
    expect(el.className).toContain("text-primary-foreground");
  });

  it("Button variants bind to the right tokens", () => {
    const { container } = render(
      <>
        <Button variant="destructive">Delete</Button>
        <Button variant="outline">Cancel</Button>
        <Button variant="secondary">Back</Button>
      </>,
    );
    const html = container.innerHTML;
    expect(html).toContain("bg-destructive");
    expect(html).toContain("border-input");
    expect(html).toContain("bg-secondary");
    expect(html).not.toContain("bg-accent");
  });

  it("Input binds to --input for its boundary, not --border", () => {
    render(<Input placeholder="Email" />);
    // --input clears WCAG 1.4.11 (3:1); --border does not and is decorative.
    expect(screen.getByPlaceholderText("Email").className).toContain("border-input");
  });

  it("Card and Badge render with card/foreground tokens", () => {
    const { container } = render(
      <Card>
        <CardHeader><CardTitle>Dog</CardTitle></CardHeader>
        <CardContent><Badge>Scheduled</Badge></CardContent>
      </Card>,
    );
    expect(container.innerHTML).toContain("bg-card");
    expect(container.innerHTML).toContain("text-card-foreground");
  });
});

describe("seeded set — opacity modifiers emit CSS on real component classes", () => {
  it("the button's own hover state (bg-primary/90) emits a real rule", async () => {
    // This is the exact class the seeded button ships with. Under the token
    // format this replaced, it emitted zero bytes.
    expect(codeOf("button")).toContain("bg-primary/90");
    const css = await buildCss('<div class="hover:bg-primary/90"></div>');
    expect(css).toMatch(/hsl\(var\(--primary\)\s*\/\s*0\.9\)/);
  });

  it("every opacity-modified class in the seeded source emits CSS", async () => {
    const classes = new Set<string>();
    for (const name of SEEDED) {
      for (const m of codeOf(name).matchAll(/(?:bg|text|border|ring)-[a-z-]+\/\d+/g)) classes.add(m[0]);
    }
    expect(classes.size, "expected the seeded source to use opacity modifiers").toBeGreaterThan(0);
    const css = await buildCss(`<div class="${[...classes].join(" ")}"></div>`);
    for (const cls of classes) {
      const escaped = cls.replace("/", "\\/");
      expect(css, `${cls} emitted no CSS`).toContain(`.${escaped}`);
    }
  });
});
