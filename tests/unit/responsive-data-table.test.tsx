/**
 * The responsive data table (card 2.3.50).
 *
 * Three things are under test, and they fail in three different ways.
 *
 * 1. THE PRIORITY RULE. Its failure is a column that vanishes and does not come
 *    back, or — worse — a table that renders completely empty on a phone and
 *    perfectly on the laptop it was written on. Both are silent.
 *
 * 2. THE WIRING BETWEEN THE RULE AND TAILWIND. The classes are only CSS if
 *    Tailwind has literally seen them in a scanned file. A template string, or
 *    a content glob that does not reach lib/, produces markup that looks right
 *    in the DOM and has no styles behind it. Nothing errors.
 *
 * 3. TABLE SEMANTICS AND THE SCROLL REGION. A table that has stopped being a
 *    table to a screen reader still looks fine, and the columns past the edge
 *    of a mouse-only scroll container are simply unreachable without one.
 *
 * jsdom does no layout, so what is proven here is the contract the geometry
 * rests on; the geometry itself is proven in a real browser — see the K9Coach
 * responsive spec for this card.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import type { Config } from "tailwindcss";
import type { ColumnDef } from "@tanstack/react-table";

import config from "../../tailwind.config";
import { DataTable } from "../../components/ui/data-table";
import {
  PRIORITY_CLASS,
  DEFAULT_PRIORITY,
  hasAlwaysVisibleColumn,
  responsiveColumnClass,
  type ColumnPriority,
} from "../../lib/table/responsive-columns";

const ROOT = resolve(__dirname, "../..");

afterEach(cleanup);

type Row = { name: string; breed: string; owner: string; contact: string };

const ROWS: Row[] = [
  { name: "Bramble", breed: "Collie", owner: "Ada", contact: "ada@example.test" },
  { name: "Nettle", breed: "Lab", owner: "Bo", contact: "bo@example.test" },
];

const COLUMNS: ColumnDef<Row>[] = [
  { accessorKey: "name", header: "Name", meta: { priority: "primary" } },
  { accessorKey: "breed", header: "Breed", meta: { priority: "high" } },
  { accessorKey: "owner", header: "Owner", meta: { priority: "medium" } },
  { accessorKey: "contact", header: "Contact", meta: { priority: "low" } },
];

/* ── 1. the priority rule ───────────────────────────────────────────────── */

describe("column priority decides what survives a narrow container", () => {
  it("keeps a primary column at every width", () => {
    expect(responsiveColumnClass("primary", false)).toBe("");
  });

  it.each(["high", "medium", "low"] as const)(
    "%s columns hide until the container earns them",
    (priority) => {
      const cls = responsiveColumnClass(priority, false);
      expect(cls).toContain("hidden");
      // ...and come back as a table cell, not a block — a `display: block`
      // `<td>` leaves the table's own layout and its column collapses.
      expect(cls).toContain("table-cell");
    },
  );

  it("never hides a column whose author did not classify it", () => {
    // Dropping a column nobody ranked is the worse of the two failures.
    expect(DEFAULT_PRIORITY).toBe("primary");
    expect(responsiveColumnClass(undefined, false)).toBe("");
  });

  it("'show every column' switches the whole rule off", () => {
    for (const p of ["primary", "high", "medium", "low", undefined] as const) {
      expect(responsiveColumnClass(p, true)).toBe("");
    }
  });
});

describe("a column set that could empty the table is refused", () => {
  it("accepts any set with a primary column", () => {
    expect(hasAlwaysVisibleColumn(["primary", "low", "low"])).toBe(true);
    expect(hasAlwaysVisibleColumn([undefined, "low"])).toBe(true);
    expect(hasAlwaysVisibleColumn([])).toBe(true);
  });

  it("rejects a set where every column can hide", () => {
    expect(hasAlwaysVisibleColumn(["high", "medium", "low"])).toBe(false);
  });

  it("throws rather than render a table that is blank on a phone", () => {
    // This is the failure that looks perfect on the machine it was written on.
    const allHideable: ColumnDef<Row>[] = COLUMNS.map((c) => ({
      ...c,
      meta: { priority: "low" as const },
    }));
    expect(() =>
      render(<DataTable columns={allHideable} data={ROWS} caption="Dogs" narrow="priority" />),
    ).toThrow(/renders empty on a narrow screen/);
  });

  it("does not apply the rule in scroll mode, where nothing is hidden", () => {
    const allHideable: ColumnDef<Row>[] = COLUMNS.map((c) => ({
      ...c,
      meta: { priority: "low" as const },
    }));
    expect(() =>
      render(<DataTable columns={allHideable} data={ROWS} caption="Dogs" narrow="scroll" />),
    ).not.toThrow();
  });
});

/* ── 2. the rule is actually wired to Tailwind ──────────────────────────── */

describe("the classes reach Tailwind", () => {
  const configSource = readFileSync(resolve(ROOT, "tailwind.config.ts"), "utf8");

  /**
   * Compile the priority classes with the REAL config and read back what the
   * browser would actually get.
   *
   * Asserting on the config file instead would prove only that somebody wrote
   * a boundary down. This proves the rule exists as CSS, which is the thing
   * that has a silent failure mode: a class Tailwind has not seen emits
   * nothing, and the column simply never comes back.
   */
  async function boundariesRem(): Promise<Record<ColumnPriority, number>> {
    const markup = Object.values(PRIORITY_CLASS)
      .filter(Boolean)
      .map((c) => `<td class="${c}"></td>`)
      .join("");
    const { css } = await postcss([
      tailwindcss({ ...(config as Config), content: [{ raw: markup, extension: "html" }] }),
    ]).process("@tailwind utilities;", { from: undefined });

    // Which @container boundary each emitted selector sits under. Selectors
    // arrive CSS-escaped (`.\@xs\/datatable\:table-cell`), so compare on the
    // unescaped form rather than trying to rebuild the escaping here.
    const emitted = new Map<string, number>();
    postcss.parse(css).walkAtRules("container", (at) => {
      const minWidth = /min-width:\s*([\d.]+)rem/.exec(at.params);
      if (!minWidth) return;
      at.walkRules((rule) => {
        emitted.set(rule.selector.replace(/\\/g, "").replace(/^\./, ""), Number(minWidth[1]));
      });
    });

    const out = {} as Record<ColumnPriority, number>;
    for (const [priority, cls] of Object.entries(PRIORITY_CLASS) as [ColumnPriority, string][]) {
      if (!cls) {
        out[priority] = 0; // no boundary — visible at every width
        continue;
      }
      const variant = cls.split(" ")[1]; // the `@…:table-cell` half
      expect(
        emitted.has(variant),
        `${priority} (${variant}) produced no CSS at all — the column would never come back`,
      ).toBe(true);
      out[priority] = emitted.get(variant)!;
    }
    return out;
  }

  it("the content globs scan lib/, where the classes live", () => {
    // Without this the rule is defined, imported, applied — and emits no CSS.
    expect(configSource).toMatch(/["']\.\/lib\/\*\*\/\*\.\{ts,tsx\}["']/);
  });

  it("every priority compiles to a real container query", async () => {
    const rem = await boundariesRem();
    expect(rem.primary).toBe(0);
    for (const p of ["high", "medium", "low"] as const) expect(rem[p]).toBeGreaterThan(0);
  });

  it("the ladder ascends — each step needs at least as much room", async () => {
    // A scale that went 20rem / 42rem / 28rem would still compile and still
    // render; it would just hide a `medium` column while showing the `low` one
    // next to it, which no other check would notice.
    const rem = await boundariesRem();
    expect(rem.high).toBeGreaterThan(rem.primary);
    expect(rem.medium).toBeGreaterThan(rem.high);
    expect(rem.low).toBeGreaterThan(rem.medium);
  });

  it("every step is reachable inside a standard page column", async () => {
    // The ceiling has to fit the page this template actually builds: a centred
    // max-w-2xl column is 672px, ~624px of content once the padding is off, and
    // that is the widest a table gets however large the monitor. A `low` step
    // above it is a column NOBODY EVER SEES, at any width, on any device — and
    // nothing reports it, because a container query that never matches is not
    // an error.
    const PAGE_COLUMN_REM = 624 / 16;
    const rem = await boundariesRem();
    for (const p of ["high", "medium", "low"] as const) {
      expect(rem[p], `${p} never fits a standard page column`).toBeLessThanOrEqual(
        PAGE_COLUMN_REM,
      );
    }
  });

  it("a `high` column still fits on a real phone", async () => {
    // The regression this guards is a plausible-looking one: reuse the layout
    // boundary `compact` (24rem/384px) and every `high` column lands above a
    // 390px phone's ~358px content box, so they vanish on every phone made —
    // including ones with room for three columns. Nothing errors; the table
    // just looks sparse, on the one device it was built for.
    const PHONE_CONTENT_BOX_REM = 358 / 16;
    const rem = await boundariesRem();
    expect(rem.high).toBeLessThan(PHONE_CONTENT_BOX_REM);
  });

  it("writes every class out in full — no interpolation", () => {
    // Comments off first: the file documents this rule by showing the broken
    // form, so matching raw source would fail on the explanation of the bug
    // rather than the bug.
    const src = code(readFileSync(resolve(ROOT, "lib/table/responsive-columns.ts"), "utf8"));
    // A class built with `${}` is invisible to the scanner and emits nothing.
    for (const cls of Object.values(PRIORITY_CLASS).filter(Boolean)) {
      expect(src).toContain(cls);
    }
    expect(src).not.toMatch(/`[^`]*@\$\{/);
  });

  it("the table declares the container those classes query", () => {
    const src = readFileSync(resolve(ROOT, "components/ui/data-table.tsx"), "utf8");
    expect(src).toContain("@container/datatable");
  });
});

/**
 * Assertions below are about the CODE, so the comments come off first: this
 * component's header explains the rules by naming what it must not do ("a
 * resize listener writing TanStack's columnVisibility"), and matching raw
 * source would fail on the explanation rather than the behaviour.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("the narrow behaviour is CSS, not measurement", () => {
  const src = code(readFileSync(resolve(ROOT, "components/ui/data-table.tsx"), "utf8"));

  it("ships no JavaScript width detection", () => {
    // Any of these means the first paint is a guess and the correction is a
    // visible flash — docs/responsive.md §4.
    for (const banned of ["useMediaQuery", "matchMedia", "innerWidth", "ResizeObserver"]) {
      expect(src).not.toContain(banned);
    }
  });

  it("asks its own container, never the window", () => {
    expect(src).not.toMatch(/\b(sm|md|lg|xl):/);
  });
});

/* ── 3. semantics, and the scroll region ────────────────────────────────── */

describe("it is still a table", () => {
  it("renders real table semantics with an accessible name", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} caption="Your dogs" />);
    const table = screen.getByRole("table", { name: "Your dogs" });
    expect(within(table).getAllByRole("row")).toHaveLength(ROWS.length + 1); // + header
    expect(within(table).getAllByRole("columnheader")).toHaveLength(COLUMNS.length);
  });

  it("hides a column from BOTH the header and the body, never one of them", () => {
    // A header hidden without its cells (or the reverse) shifts every row by
    // one column and the table silently reports the wrong data.
    const { container } = render(
      <DataTable columns={COLUMNS} data={ROWS} caption="Your dogs" narrow="priority" />,
    );
    for (const priority of ["high", "medium", "low"] as const) {
      const cls = PRIORITY_CLASS[priority].split(" ")[1]; // the @…:table-cell half
      const cells = container.querySelectorAll(`[class*="${cls}"]`);
      // one <th> + one <td> per row.
      expect(cells.length).toBe(1 + ROWS.length);
    }
  });

  it("the scrolling element is reachable from the keyboard and named", () => {
    // Columns past the edge are otherwise mouse-only — WCAG 2.1.1.
    render(<DataTable columns={COLUMNS} data={ROWS} caption="Your dogs" />);
    const region = screen.getByRole("region", { name: /Your dogs/ });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.className).toContain("overflow-auto");
  });

  it("does not name the scroll region the same as the section around it", () => {
    // The idiomatic way to place a table on a page here is
    // `<section aria-labelledby={headingId}>` — which is itself a landmark. Two
    // nested landmarks with identical names are ambiguous exactly when
    // landmarks matter most: navigating by them. Found in CI on K9Coach's
    // dashboard, where the two were indistinguishable.
    render(
      <section aria-labelledby="dogs-heading">
        <h2 id="dogs-heading">Your dogs</h2>
        <DataTable columns={COLUMNS} data={ROWS} caption="Your dogs" />
      </section>,
    );
    // Both landmarks exist, and exactly one of them is the table's scroller.
    expect(screen.getAllByRole("region")).toHaveLength(2);
    const region = screen.getByRole("region", { name: "Your dogs, scrollable" });
    expect(region.getAttribute("tabindex")).toBe("0");
    // The table itself keeps the plain name — only the scroller is qualified.
    expect(screen.getByRole("table", { name: "Your dogs" })).toBeTruthy();
  });

  it("pins the first column without pinning the rest", () => {
    const { container } = render(
      <DataTable columns={COLUMNS} data={ROWS} caption="Your dogs" />,
    );
    const firstRow = container.querySelectorAll("tbody tr")[0];
    const cells = firstRow.querySelectorAll("td");
    expect(cells[0].className).toContain("sticky");
    expect(cells[1].className).not.toContain("sticky");
    // Opaque via the row, so scrolled columns cannot show through it.
    expect(cells[0].className).toContain("bg-inherit");
    expect(firstRow.className).toContain("hover:bg-muted");
    expect(firstRow.className).not.toContain("bg-muted/50");
  });

  it("can be told not to pin anything", () => {
    const { container } = render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        caption="Your dogs"
        stickyFirstColumn={false}
      />,
    );
    expect(container.querySelector("tbody td")?.className).not.toContain("sticky");
  });

  it("announces the sort state on the header cell, not just in an icon", () => {
    const sortable: ColumnDef<Row>[] = [
      { accessorKey: "name", header: "Name", enableSorting: true, meta: { priority: "primary" } },
    ];
    render(<DataTable columns={sortable} data={ROWS} caption="Your dogs" />);
    expect(screen.getByRole("columnheader").getAttribute("aria-sort")).toBe("none");
  });

  it("says so when there is nothing to show, inside the table", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        caption="Your dogs"
        emptyMessage="No dogs yet."
      />,
    );
    expect(screen.getByText("No dogs yet.")).toBeTruthy();
    // Spanning every column, so the message is not squeezed into column one.
    expect(screen.getByRole("cell").getAttribute("colspan")).toBe(String(COLUMNS.length));
  });
});

describe("the columns menu", () => {
  it("is offered by default in priority mode and not in scroll mode", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} caption="A" narrow="priority" />);
    expect(screen.getByRole("button", { name: /columns/i })).toBeTruthy();
    cleanup();
    render(<DataTable columns={COLUMNS} data={ROWS} caption="B" narrow="scroll" />);
    expect(screen.queryByRole("button", { name: /columns/i })).toBeNull();
  });

  it("can be asked for in scroll mode", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} caption="C" narrow="scroll" columnMenu />);
    expect(screen.getByRole("button", { name: /columns/i })).toBeTruthy();
  });

  it("meets the touch-target minimum", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} caption="D" narrow="priority" />);
    expect(screen.getByRole("button", { name: /columns/i }).className).toContain("min-h-11");
  });
});
