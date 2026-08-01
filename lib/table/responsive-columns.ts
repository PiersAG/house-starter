// Column priority — the data half of the responsive data table (card 2.3.50).
//
// WHY THIS IS A SEPARATE FILE FROM THE COMPONENT
// The rule "which columns survive a narrow container" is the only part of the
// table with a wrong answer. Everything else is markup. Kept here it is a pure
// function over plain values, unit-tested directly, and — because
// components/ui/** is excluded from the coverage report — actually measured.
//
// ── THE CLASSES ARE THE MECHANISM, NOT A HINT ──────────────────────────────
// Hiding is done by CSS container queries, not by JavaScript deciding what
// fits. docs/responsive.md §4 rules out the JS route and the reason applies
// exactly here: a `useMediaQuery`/ResizeObserver cannot know the width during
// server rendering, so the first paint would show every column and then drop
// four of them in front of the user. A container query is resolved by the
// browser at layout time, so the server's HTML is already correct at 320px.
//
// It also means the table asks ITS OWN container. The same table in a page, a
// two-column grid and a modal hides different columns, correctly, with no prop
// threaded down from whoever knows the real width.

import type { RowData } from "@tanstack/react-table";

/**
 * How important a column is. Only `primary` is guaranteed a place at every
 * width — everything else earns its slot from the container.
 *
 * Read as "appears once the container is at least":
 *   primary  always         the identifying column: who/what this row IS
 *   high     @xs  (20rem)   needed to act on the row
 *   medium   @md  (28rem)   useful context
 *   low      @xl  (36rem)   nice to have; the first thing to go
 *
 * ── WHY THIS LADDER AND NOT `compact`/`roomy` ──────────────────────────────
 * Those two name LAYOUT boundaries — "a horizontal row of controls stops
 * fitting", "there is room for a side-by-side layout". A column is a fraction
 * of a control row, so reusing them costs real columns: `compact` is 24rem
 * (384px), and a 390px phone's content box is ~358px after page padding, so
 * every `high` column would disappear on every phone — including ones with
 * ample room for two. The ladder a table needs is a count of columns, not a
 * layout decision, so it gets its own steps. docs/responsive.md allows exactly
 * this where the reason is specific to one component; this is that case, and
 * these are the plugin's own named steps rather than magic numbers.
 *
 * ── AND WHY THE TOP OF THE LADDER IS 36rem, NOT HIGHER ─────────────────────
 * The ceiling has to fit inside the page this template actually builds. A
 * dashboard page is a centred `max-w-2xl` column — 672px, so ~624px of content
 * once the padding is off — and that is the widest a table gets no matter how
 * large the monitor is. Put `low` at 42rem (672px) and those columns never
 * appear at ANY width in a standard page: not a bug the browser reports, just
 * a column nobody ever sees. Every step below is reachable inside 624px.
 *
 * The steps in practice, in a standard page column:
 *   ≤320px phone  → primary                  (content box ~288px)
 *    390px phone  → primary + high           (~358px)
 *    ≥640px       → everything               (~592px and up)
 */
export type ColumnPriority = "primary" | "high" | "medium" | "low";

/**
 * Priority → the Tailwind classes that implement it.
 *
 * `hidden` then `table-cell` (NOT `block`): restoring a `<th>`/`<td>` to
 * `display: block` takes it out of the table's own layout, and the column it
 * belonged to collapses while the cell floats at the row's start. `table-cell`
 * puts it back in the grid it came from.
 *
 * The container is named — `@compact/datatable` rather than `@compact` — so a
 * table nested inside another container queries the table's wrapper and not
 * whichever ancestor happens to be closest.
 *
 * WRITTEN OUT IN FULL, DELIBERATELY. Tailwind scans source text for complete
 * class names; a string built as `` `@${size}/datatable:table-cell` `` produces
 * no CSS at all, and the failure is silent — the column simply never comes
 * back. tests/unit/responsive-data-table.test.tsx pins both this and the
 * content glob that has to reach this file.
 */
export const PRIORITY_CLASS: Record<ColumnPriority, string> = {
  primary: "",
  high: "hidden @xs/datatable:table-cell",
  medium: "hidden @md/datatable:table-cell",
  low: "hidden @xl/datatable:table-cell",
};

/** The priority assumed for a column that does not declare one. */
export const DEFAULT_PRIORITY: ColumnPriority = "primary";

/**
 * The classes for one column's cells.
 *
 * `showAll` is the user's explicit "show every column" choice. When it is set,
 * nothing is priority-hidden and the table falls back to scrolling — the user
 * asked for the columns, so they get the columns, and the scroll container was
 * always there underneath.
 *
 * An undeclared priority never hides. Silently dropping a column its author
 * never classified is the worse failure of the two.
 */
export function responsiveColumnClass(
  priority: ColumnPriority | undefined,
  showAll: boolean,
): string {
  if (showAll) return "";
  return PRIORITY_CLASS[priority ?? DEFAULT_PRIORITY];
}

/**
 * Does this column set keep at least one column at every width?
 *
 * A set of columns all marked `high` or below renders as a completely empty
 * table on a 320px phone: no error, no warning, just rows of nothing. That is
 * the one way to hold this API that produces a broken screen rather than an
 * ugly one, so the component refuses to render it — see the note there.
 */
export function hasAlwaysVisibleColumn(
  priorities: readonly (ColumnPriority | undefined)[],
): boolean {
  if (priorities.length === 0) return true; // an empty table hides nothing
  return priorities.some((p) => (p ?? DEFAULT_PRIORITY) === "primary");
}

/** Per-column options this template adds to TanStack's `meta`. */
declare module "@tanstack/react-table" {
  // The generics are unused here but cannot be dropped: an augmentation has to
  // restate the original declaration's parameters exactly or it declares a
  // different interface and the `meta` field never appears.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** How important this column is when the container runs out of room. */
    priority?: ColumnPriority;
    /** Plain-text name for the Columns menu, when the header is not a string. */
    label?: string;
  }
}
