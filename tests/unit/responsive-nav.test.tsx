/**
 * The responsive primary nav (card 2.3.49).
 *
 * Two things are under test and they fail in different ways.
 *
 * 1. THE OVERFLOW BUDGET. Capabilities add nav entries over time, and the bar
 *    has finite width. The failure mode is not an exception — it is six tabs
 *    squeezed to 40px each on a 320px screen, under the touch-target minimum,
 *    or a bar that wraps to two rows and covers the page. So the partition is
 *    tested at the counts the app will actually reach, including counts it has
 *    not reached yet.
 *
 * 2. THE ARRANGEMENT SWITCH. That it is a CONTAINER query and not a viewport
 *    one, that both layouts clear the fixed bar using the SAME named boundary
 *    the nav switches on, and that the accessibility affordances survive the
 *    rearrange. jsdom does not do layout, so the geometry itself is proven in
 *    the browser (see the card's demonstration); what is proven here is the
 *    contract the geometry depends on.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AppNav, MAX_TABS, partitionNav } from "../../components/AppNav";
import type { NavItem } from "../../lib/nav/primary-nav";

const ROOT = resolve(__dirname, "../..");

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

afterEach(cleanup);

const make = (n: number): NavItem[] =>
  Array.from({ length: n }, (_, i) => ({ href: `/dashboard/item-${i}`, label: `Item ${i}` }));

/* ── 1. the overflow budget ─────────────────────────────────────────────── */

describe("the bar never overflows, however many links exist", () => {
  // Today's real nav is 3. All three capabilities on is 6. The rest are the
  // counts this will reach as capabilities land.
  for (const n of [1, 3, 4, 5, 6, 7, 12]) {
    it(`${n} links: the bar holds at most ${MAX_TABS} slots`, () => {
      const { tabs, overflow } = partitionNav(make(n));
      const slots = tabs.length + (overflow.length > 0 ? 1 : 0); // +1 for "More"
      expect(slots).toBeLessThanOrEqual(MAX_TABS);
      // Nothing is ever lost: every link is either a tab or in the menu.
      expect(tabs.length + overflow.length).toBe(n);
      // And nothing is duplicated between the two.
      const hrefs = [...tabs, ...overflow].map((i) => i.href);
      expect(new Set(hrefs).size).toBe(n);
    });
  }

  it("does not invent a More menu when everything fits", () => {
    expect(partitionNav(make(MAX_TABS)).overflow).toHaveLength(0);
    render(<AppNav items={make(MAX_TABS)} />);
    expect(screen.queryByText("More")).toBeNull();
  });

  it("folds the tail into More the moment one link too many appears", () => {
    render(<AppNav items={make(MAX_TABS + 1)} />);
    expect(screen.getByText("More")).toBeTruthy();
    // MAX_TABS - 1 real destinations remain visible as tabs.
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const topLevelLinks = within(nav).getAllByRole("link");
    expect(topLevelLinks).toHaveLength(MAX_TABS - 1);
  });

  it("keeps every destination reachable when many are hidden", () => {
    const items = make(12);
    const { tabs, overflow } = partitionNav(items);
    expect(overflow).toHaveLength(12 - (MAX_TABS - 1));
    // The menu is what makes them reachable; it is rendered (collapsed) rather
    // than the links being dropped.
    render(<AppNav items={items} />);
    expect(screen.getByRole("button", { name: /More destinations \(\d+\)/ })).toBeTruthy();
    expect(tabs.length + overflow.length).toBe(items.length);
  });
});

/* ── 2. accessibility survives the rearrange ────────────────────────────── */

describe("navigation semantics", () => {
  it("is a landmark with an accessible name", () => {
    render(<AppNav items={make(3)} />);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
  });

  it("marks the current page with aria-current", () => {
    render(<AppNav items={[{ href: "/dashboard", label: "Dashboard" }, ...make(2)]} />);
    const current = screen.getByRole("link", { name: "Dashboard" });
    expect(current.getAttribute("aria-current")).toBe("page");
  });

  it("gives the current page a non-colour indicator too (WCAG 1.4.1)", () => {
    render(<AppNav items={[{ href: "/dashboard", label: "Dashboard" }]} />);
    const link = screen.getByRole("link", { name: "Dashboard" });
    // The active rule is a real element, not just a text colour.
    expect(link.querySelector("span[aria-hidden]")?.className).toContain("bg-primary");
  });

  it("uses a real list so assistive tech announces the count", () => {
    render(<AppNav items={make(3)} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("listitem")).toHaveLength(3);
  });

  it("the More trigger is a real button, keyboard reachable and named", () => {
    render(<AppNav items={make(MAX_TABS + 2)} />);
    const trigger = screen.getByRole("button", { name: /More destinations/ });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

/* ── 3. the switch is a container query, and the layouts agree with it ──── */

/**
 * Assertions below are about the CODE, so the comments have to come off first.
 * This component's header explains the rules by naming exactly what it must not
 * do — "no useMediaQuery", "not a <MobileNav/>", "which a `md:` class could
 * never do". Matching raw source would fail on the documentation that is the
 * most valuable thing here, and the fix would be to delete the explanations.
 * So: strip comments, assert on what is left.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, including JSDoc
    .replace(/^\s*\/\/.*$/gm, "") // whole-line // comments
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ""); // JSX comments
}

describe("the arrangement switch", () => {
  const nav = code(readFileSync(resolve(ROOT, "components/AppNav.tsx"), "utf8"));
  const layouts = ["app/dashboard/layout.tsx", "app/account/layout.tsx"];

  it("switches on the nav's own container, not the viewport", () => {
    expect(nav).toContain("@container/appnav");
    expect(nav).toMatch(/@roomy\/appnav:/);
    expect(nav).not.toMatch(/\b(sm|md|lg|xl):/);
  });

  it("ships no JavaScript width detection", () => {
    for (const banned of ["useMediaQuery", "matchMedia", "innerWidth", "addEventListener"]) {
      expect(nav).not.toContain(banned);
    }
  });

  it("pins the touch target once, so neither arrangement can lose it", () => {
    expect(nav).toContain("min-h-11");
  });

  it.each(layouts)("%s clears the fixed bar", (file) => {
    const src = code(readFileSync(resolve(ROOT, file), "utf8"));
    expect(src).toContain("@container/page");
    // Padding at narrow, removed at the boundary.
    expect(src).toMatch(/pb-24[^"]*@roomy\/page:pb-0/);
  });

  it("the layouts' boundary is the SAME one the nav switches on", () => {
    // If these drifted, either the bar would cover page content or desktop
    // pages would carry dead space. Same word, checked, in all three files.
    const navBoundary = /@(\w+)\/appnav:/.exec(nav)?.[1];
    expect(navBoundary).toBe("roomy");
    for (const file of layouts) {
      const src = code(readFileSync(resolve(ROOT, file), "utf8"));
      expect(/@(\w+)\/page:pb-0/.exec(src)?.[1]).toBe(navBoundary);
    }
  });

  it("both segments render the one nav — no second copy anywhere", () => {
    for (const file of layouts) {
      expect(code(readFileSync(resolve(ROOT, file), "utf8"))).toContain("<AppNav />");
    }
    // A MobileNav/DesktopNav pair is the failure this pattern exists to prevent.
    for (const forbidden of ["MobileNav", "DesktopNav", "NavMobile", "NavDesktop"]) {
      expect(nav).not.toContain(forbidden);
    }
  });
});
