"use client";

/**
 * The responsive data table (card 2.3.50).
 *
 * shadcn's Data Table pattern (TanStack Table for the model, our own `table.tsx`
 * primitives for the markup) with the two narrow-container behaviours built in,
 * so no table has to invent them and every table gets them by default.
 *
 * Provenance: the composition follows https://ui.shadcn.com/docs/components/data-table
 * (MIT). The responsive half below is ours and is not in the upstream recipe —
 * upstream's column visibility is a manual menu only.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * A table is the one component that cannot reflow. Six columns of a `<table>`
 * on a 360px phone do not wrap, they push the page sideways: the whole document
 * gains a horizontal scrollbar, the nav slides off, and every other element on
 * the page is now 600px wide. One table breaks the entire screen.
 *
 * ── THE TWO BEHAVIOURS, AND HOW TO CHOOSE ──────────────────────────────────
 *
 *   narrow="scroll"   (default)
 *     Every column stays. The table scrolls sideways inside its own box, and
 *     the first column stays pinned so a row never loses the thing that says
 *     which row it is. Choose this when the columns are comparable and dropping
 *     any of them would make the table pointless — a ledger, a price grid.
 *
 *   narrow="priority"
 *     Columns declare `meta.priority`, and the less important ones are hidden
 *     until the container has room. Choose this when the columns are ranked and
 *     the top two or three answer the question on their own — a client list, a
 *     booking list. The user can still get the rest from the Columns menu.
 *
 * Both keep the scroll container underneath, so neither can overflow the page.
 *
 * ── WHY THE HIDING IS CSS AND NOT STATE ────────────────────────────────────
 * The obvious build is a resize listener writing TanStack's `columnVisibility`.
 * docs/responsive.md §4 rules that out and this is the clearest case for it:
 * the server cannot know the viewport, so the first paint would show all six
 * columns and then visibly drop three. Container-query classes are resolved by
 * the browser during layout — correct in the server's own HTML, at every width,
 * with no measurement and no JavaScript.
 *
 * `columnVisibility` is still here, doing the job it is good at: what the USER
 * chose. The two never contradict each other because they answer different
 * questions — see the Columns menu below.
 */

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, ChevronsUpDown, Columns3 } from "lucide-react";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  hasAlwaysVisibleColumn,
  responsiveColumnClass,
} from "@/lib/table/responsive-columns";

/** What the table does when its container is narrower than its columns. */
export type NarrowBehaviour = "scroll" | "priority";

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /**
   * What this table is a table of — "Your dogs", "Invoices". Becomes the
   * table's `<caption>` and names the scroll region, so both are announced.
   * Required: an unnamed table is a wall of cells to a screen-reader user.
   */
  caption: string;
  /** Show the caption on screen as well as to assistive tech. */
  showCaption?: boolean;
  /** See NarrowBehaviour. Default `"scroll"`. */
  narrow?: NarrowBehaviour;
  /** Pin the first column while the rest scrolls. Default `true`. */
  stickyFirstColumn?: boolean;
  /** Offer the Columns menu. Default: on when `narrow === "priority"`. */
  columnMenu?: boolean;
  /** Shown in place of rows when there are none. */
  emptyMessage?: string;
  className?: string;
}

/** The `aria-sort` value for a header cell — WCAG/ARIA, not decoration. */
function ariaSort(
  column: Column<never, unknown> | { getIsSorted: () => false | "asc" | "desc" },
): "ascending" | "descending" | "none" | undefined {
  const dir = column.getIsSorted();
  if (dir === "asc") return "ascending";
  if (dir === "desc") return "descending";
  return "none";
}

export function DataTable<TData, TValue>({
  columns,
  data,
  caption,
  showCaption = false,
  narrow = "scroll",
  stickyFirstColumn = true,
  columnMenu,
  emptyMessage = "Nothing to show yet.",
  className,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});

  /**
   * The user's "show me everything" escape hatch, and the ONLY thing that
   * switches priority hiding off.
   *
   * This is why the CSS rule and the menu cannot contradict each other. They
   * are asked different questions:
   *
   *   the priority classes answer "does this column fit here?"
   *   `columnVisibility`   answers "does this user want this column at all?"
   *   `showAll`            answers "ignore the first question entirely"
   *
   * A column the user unticks is not rendered at any width, so no class can
   * argue with it. A column the user cannot see because the container is narrow
   * is recovered with one tap on "Show every column", after which the table
   * scrolls instead — the behaviour they implicitly asked for by wanting all
   * the columns on a small screen.
   *
   * It starts `false`, so the first render is pure CSS: no flash, nothing to
   * hydrate, correct in the server's HTML.
   */
  const [showAll, setShowAll] = React.useState(false);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const leafColumns = table.getVisibleLeafColumns();

  /**
   * A column set that can hide everything is a programming error, and it is one
   * that shows up as a blank screen on a phone and a perfect screen on the
   * laptop it was written on — the failure most likely to ship. So it throws,
   * for the same reason `fluid()` in tailwind.config.ts throws: the condition
   * is a property of the code, not of the data, so it fires on the first render
   * in development and in the test suite, never first in front of a user.
   */
  if (narrow === "priority") {
    const priorities = columns.map((c) => c.meta?.priority);
    if (!hasAlwaysVisibleColumn(priorities)) {
      throw new Error(
        `DataTable "${caption}": every column is priority "high" or lower, so ` +
          `the table renders empty on a narrow screen. Mark the column that ` +
          `identifies the row as priority "primary".`,
      );
    }
  }

  /** The responsive classes for a column — none at all in scroll mode. */
  const priorityClass = (columnId: string): string => {
    if (narrow !== "priority") return "";
    const meta = table.getColumn(columnId)?.columnDef.meta;
    return responsiveColumnClass(meta?.priority, showAll);
  };

  /**
   * Pinned-column classes.
   *
   * `bg-inherit` rather than `bg-background`: the cell has to be opaque or the
   * scrolled content shows through it, but a fixed colour would also mean the
   * pinned cell stayed pale while the rest of its row highlighted on hover. It
   * inherits the row's own computed background instead, so it tracks every row
   * state for free. That only works because the row's hover below is fully
   * opaque — `bg-muted`, not the primitive's `bg-muted/50`, which would let the
   * scrolling columns show through the pinned one.
   */
  const stickyClass = (index: number, header: boolean): string =>
    stickyFirstColumn && index === 0
      ? cn("sticky left-0 border-r border-border bg-inherit", header ? "z-20" : "z-10")
      : "";

  const showMenu = columnMenu ?? narrow === "priority";
  const hideableColumns = table.getAllLeafColumns().filter((c) => c.getCanHide());

  return (
    // The container the whole thing measures itself against. Named, so a table
    // inside a card inside a page queries THIS box and not one of the others.
    <div className={cn("@container/datatable", className)}>
      {showMenu && hideableColumns.length > 0 ? (
        <div className="mb-fluid-2xs flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded border border-border",
                "px-3 py-1.5 text-fluid-sm font-medium text-text-primary",
                "hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              )}
            >
              <Columns3 aria-hidden className="h-4 w-4" />
              Columns
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel className="font-normal text-text-secondary">
                {narrow === "priority"
                  ? "Less important columns hide themselves when there is no room."
                  : "Choose which columns to show."}
              </DropdownMenuLabel>
              {narrow === "priority" ? (
                <>
                  <DropdownMenuCheckboxItem
                    checked={showAll}
                    onCheckedChange={(v) => setShowAll(Boolean(v))}
                    className="min-h-11 text-fluid-sm"
                  >
                    Show every column
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {hideableColumns.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={column.getIsVisible()}
                  onCheckedChange={(v) => column.toggleVisibility(Boolean(v))}
                  className="min-h-11 text-fluid-sm"
                >
                  {column.columnDef.meta?.label ??
                    (typeof column.columnDef.header === "string"
                      ? column.columnDef.header
                      : column.id)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      <div className="rounded-lg border border-border">
        <Table
          containerProps={{
            // The element that scrolls must be focusable or the columns past
            // the edge are mouse-only (WCAG 2.1.1). `role="region"` + a name is
            // what makes that tab stop mean something when it is announced.
            role: "region",
            "aria-label": caption,
            tabIndex: 0,
            className:
              "rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
          }}
        >
          <TableCaption className={cn("mt-0 px-3 py-2", !showCaption && "sr-only")}>
            {caption}
          </TableCaption>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              // Opaque, so the pinned header cell's bg-inherit has a colour.
              <TableRow key={headerGroup.id} className="bg-surface hover:bg-surface">
                {headerGroup.headers.map((header, i) => {
                  const sortable = header.column.getCanSort();
                  return (
                    <TableHead
                      key={header.id}
                      aria-sort={sortable ? ariaSort(header.column) : undefined}
                      className={cn(
                        "text-fluid-xs whitespace-nowrap",
                        priorityClass(header.column.id),
                        stickyClass(i, true),
                      )}
                    >
                      {header.isPlaceholder ? null : sortable ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "inline-flex min-h-11 items-center gap-1 rounded font-medium",
                            "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                          )}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon direction={header.column.getIsSorted()} />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow className="bg-background hover:bg-background">
                <TableCell
                  colSpan={Math.max(leafColumns.length, 1)}
                  className="py-fluid-md text-center text-fluid-sm text-text-secondary"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                // `hover:bg-muted` overrides the primitive's `bg-muted/50` —
                // cn() is tailwind-merge, so the later class wins whatever
                // order the two rules land in the stylesheet. Opacity here
                // would show the scrolling columns through the pinned one.
                <TableRow key={row.id} className="bg-background hover:bg-muted">
                  {row.getVisibleCells().map((cell, i) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        "text-fluid-sm",
                        priorityClass(cell.column.id),
                        stickyClass(i, false),
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Sort affordance. `aria-hidden` — `aria-sort` on the `<th>` already says it,
 *  and saying it twice is noise in a screen reader. */
function SortIcon({ direction }: { direction: false | "asc" | "desc" }) {
  const Icon = direction === "asc" ? ChevronUp : direction === "desc" ? ChevronDown : ChevronsUpDown;
  return <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-60" />;
}
