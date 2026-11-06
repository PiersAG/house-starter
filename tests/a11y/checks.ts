// The accessibility checks the a11y suites share (app-business-core issue 720).
// pages.spec.ts runs them on every page; keyboard.spec.ts proves they catch planted
// faults and covers the keyboard journeys (menus, the modal dialog).

import { type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Roles that must carry a name for a screen reader to announce anything useful. */
const NAMED_ROLES = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "img",
  "dialog",
  "alertdialog",
];

export async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(", ")}`,
  );
}

/** Lines of the accessibility tree for a role that has no name. */
export async function unnamedInAccessibilityTree(page: Page): Promise<string[]> {
  const tree = await page.locator("body").ariaSnapshot();
  const role = new RegExp(`^\\s*- (${NAMED_ROLES.join("|")})(?=[\\s:\\[]|$)(?!\\s*")`);
  return tree.split("\n").filter((line) => role.test(line));
}

/** What a screen reader navigates by: landmarks, headings, title, language. */
export async function structureProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      return el.getClientRects().length > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const mains = Array.from(document.querySelectorAll("main, [role=main]")).filter(visible);
    if (mains.length !== 1) problems.push(`expected one main landmark, found ${mains.length}`);
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).filter(visible);
    const h1s = headings.filter((h) => h.tagName === "H1");
    if (h1s.length !== 1) problems.push(`expected one top-level heading, found ${h1s.length}`);
    let previous = 0;
    for (const h of headings) {
      const level = Number(h.tagName.slice(1));
      if (previous && level > previous + 1) {
        problems.push(`heading level skips from h${previous} to h${level} at "${h.textContent?.trim()}"`);
      }
      previous = level;
    }
    if (!document.title.trim()) problems.push("the page has no title");
    if (!document.documentElement.lang) problems.push("the page does not declare its language");
    return problems;
  });
}

export type KeyboardReport = { candidates: number; missed: string[]; noVisibleFocus: string[]; obscured: string[] };

/**
 * Walk the page with Tab alone. Every visible, enabled interactive element must be
 * reached; each must show a visible focus indicator when it is (WCAG 2.4.7); and none
 * may be hidden behind something else when focused (WCAG 2.4.11).
 */
export async function keyboardWalk(page: Page): Promise<KeyboardReport> {
  const candidates = await page.evaluate(() => {
    const selector = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      "[tabindex]",
      "[contenteditable=true]",
    ].join(",");
    let n = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const s = getComputedStyle(el);
      const shown = el.getClientRects().length > 0 && s.visibility !== "hidden" && s.display !== "none";
      const off =
        (el as HTMLButtonElement).disabled ||
        el.closest("[inert], [aria-hidden=true]") !== null ||
        el.getAttribute("tabindex") === "-1";
      // A visually hidden element (a skip link) is reachable but not required here.
      const rect = el.getBoundingClientRect();
      if (!shown || off || rect.width < 2 || rect.height < 2) continue;
      el.dataset.kbd = String(n++);
    }
    (document.activeElement as HTMLElement | null)?.blur();
    return n;
  });

  const reached = new Set<string>();
  const noVisibleFocus: string[] = [];
  const obscured: string[] = [];
  for (let i = 0; i < candidates + 15; i++) {
    await page.keyboard.press("Tab");
    const now = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring =
        (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
        (s.boxShadow !== "" && s.boxShadow !== "none");
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const covered = hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el) && !(hit instanceof HTMLLabelElement && hit.control === el);
      return {
        id: el.dataset.kbd ?? null,
        label: `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`,
        ring,
        covered,
      };
    });
    if (!now) continue;
    if (now.id !== null && reached.has(now.id)) break; // wrapped round
    if (now.id !== null) reached.add(now.id);
    if (!now.ring) noVisibleFocus.push(now.label);
    if (now.covered) obscured.push(now.label);
  }

  const missed = await page.evaluate(
    (seen) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-kbd]"))
        .filter((el) => !seen.includes(el.dataset.kbd!))
        .map((el) => el.outerHTML.slice(0, 120)),
    [...reached],
  );
  return { candidates, missed, noVisibleFocus, obscured };
}
