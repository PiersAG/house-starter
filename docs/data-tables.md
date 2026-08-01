# Tables

Read this before putting tabular data on a screen. It is short on purpose.

> **Never hand-roll a `<table>`. Use `components/ui/data-table.tsx`.**

That is the whole rule. The rest of this page is why, and how to choose the one
option it asks you for.

---

## 1. Why a table is the special case

Everything else on a page reflows. A row of cards becomes a column, a two-column
grid becomes one — narrow the container and the content rearranges itself inside
it. A `<table>` cannot do that. Its columns are locked into a grid by the
browser's table layout, and six of them at 360px do not wrap: they push.

And they push the *page*, not the table. The document gets a horizontal
scrollbar, the fixed bottom nav slides off the left edge, headings and buttons
elsewhere are suddenly measured against a 600px page. One table breaks every
other component on the screen — which is why this is the one component the
template refuses to let each feature solve for itself.

## 2. The component

```tsx
import { DataTable } from "@/components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";

const columns: ColumnDef<Dog>[] = [
  { accessorKey: "name",  header: "Dog",   meta: { priority: "primary" } },
  { accessorKey: "breed", header: "Breed", meta: { priority: "high" } },
  { accessorKey: "owner", header: "Owner", meta: { priority: "medium" } },
];

<DataTable columns={columns} data={dogs} caption="Your dogs" narrow="priority" />;
```

`caption` is required. It becomes the table's `<caption>` and the name of the
scroll region, so both are announced. Pass `showCaption` to put it on screen
too. Everything else has a working default.

The model is [TanStack Table](https://tanstack.com/table), composed the way
shadcn's Data Table composes it, over this template's own `table.tsx`
primitives. Sorting comes free: set `enableSorting: true` on a column and the
header becomes a button with the right `aria-sort` on its cell.

## 3. The one decision: `narrow`

```
narrow="scroll"     (default)  every column stays, the table scrolls sideways,
                               the first column stays pinned
narrow="priority"              ranked columns hide until there is room for them
```

Choose by asking **whether the columns are ranked**.

**`scroll`** when they are not — a ledger, a price grid, a comparison. Every
column is the point; hiding any of them makes the table answer a different
question. The table scrolls inside its own box rather than pushing the page, and
the first column stays pinned so a row never loses the thing that says which row
it is.

**`priority`** when they are — a client list, a booking list, anything where the
first two or three columns answer the question and the rest is detail. On a
phone the reader gets a table they can actually read; the rest is one tap away
in the Columns menu.

When in doubt, `scroll`. It hides nothing.

### Priorities

| `meta.priority` | Appears once the container is | For                             |
| --------------- | ----------------------------- | ------------------------------- |
| `primary`       | always                        | who or what this row **is**     |
| `high`          | 20rem / 320px (`@xs`)         | what you need to act on the row |
| `medium`        | 28rem / 448px (`@md`)         | useful context                  |
| `low`           | 36rem / 576px (`@xl`)         | nice to have; goes first        |

In a standard page column that works out as:

```
≤320px phone   primary               (content box ~288px)
 390px phone   primary + high        (~358px)
 ≥640px        everything            (~592px and up)
```

Two things about that ladder are deliberate, and both are choices you would
otherwise make wrong.

**It is not `compact` / `roomy`.** Those name *layout* boundaries — "a
horizontal row of controls stops fitting", "there is room for a side-by-side
layout" — and a column is a fraction of a control row. `compact` is 384px, above
a 390px phone's ~358px content box, so every `high` column would vanish on every
phone made, including ones with room for three.

**It tops out at 576px, not higher.** A dashboard page is a centred `max-w-2xl`
column: 672px, so ~624px of content once padding is off, and that is the widest
a table gets however large the monitor. A step above that is a column nobody
ever sees at any width on any device — and nothing reports it, because a
container query that never matches is not an error. If you widen a page beyond
`max-w-2xl`, the ladder still works; it just has headroom to spare.

A column with no `priority` is treated as `primary` and never hides — dropping a
column nobody classified is the worse of the two failures.

**At least one column must be `primary`.** A set where everything can hide
renders as a blank table on a phone and a perfect one on the laptop it was
written on, so the component throws instead of rendering it. That is deliberate,
and it is the same reasoning as `fluid()` in `tailwind.config.ts`: the condition
is a property of the code, so it fires on the first render in development and in
the test suite, never first in front of a user.

**Put the `primary` column first.** It is the one that gets pinned, and pinning
a column that is itself hidden at narrow widths pins nothing.

## 4. What makes it responsive — and what does not

The hiding is **CSS container queries**, on the table's own container. Not a
resize listener writing `columnVisibility`.

This follows the rule in `docs/responsive.md` §4, and tables are its clearest
case. A `useMediaQuery` cannot know the width while the server renders, so the
first paint would show all six columns and then drop three in front of the
reader. A container query is resolved by the browser during layout, so the
server's own HTML is already correct at 320px — no flash, no hydration
mismatch, no JavaScript shipped to decide it.

Because it is a *container* query, the table adapts to the space **it** is given.
The same table hides different columns in a page, in a two-column grid and in a
modal, correctly, with nothing threaded down from whoever knows the real width.

### The Columns menu, and why it never fights the CSS

The menu and the CSS answer different questions, which is what keeps them from
contradicting each other:

- the priority classes answer **"does this column fit here?"**
- `columnVisibility` (the per-column ticks) answers **"does this user want this
  column at all?"** — an unticked column is not rendered at any width, so no
  class can argue with it
- **"Show every column"** answers **"ignore the first question"** — it switches
  priority hiding off entirely and the table falls back to scrolling, which is
  what someone asking for every column on a phone is asking for

It starts off, so the first render is pure CSS.

## 5. Accessibility

The transform is a *narrowing*, never a change of kind: it is a real `<table>`
at every width, with real `<th>`/`<td>` semantics, and it is announced as a
table on a phone exactly as on a desktop. There is no card/stack transform,
deliberately — turning rows into stacked cards changes what a screen reader
announces (the row/column relationship is what makes a cell mean anything) and
the header association is lost unless every cell repeats its own label.

Three things the component does that a hand-rolled table usually does not:

- **The scroll container is focusable** (`tabIndex={0}`, `role="region"`, named
  from `caption`). Columns past the edge of a mouse-only scroll box are
  unreachable from a keyboard — WCAG 2.1.1.
- **A hidden column is hidden in the header and the body together.** Hiding one
  without the other shifts every row by a column, and the table then reports the
  wrong data while looking perfectly fine.
- **Sorting state is on the cell** (`aria-sort`), not only in the icon.

The pinned column is opaque via `bg-inherit` on the cell and an opaque hover on
the row. If you restyle rows, keep the row background opaque — a translucent one
lets the scrolling columns show through the pinned one.

## 6. Where this lives

| File                                | What it holds                                     |
| ----------------------------------- | ------------------------------------------------- |
| `components/ui/data-table.tsx`      | the component                                     |
| `lib/table/responsive-columns.ts`   | the priority rule and its classes                 |
| `components/ui/table.tsx`           | the shadcn primitives it renders                  |
| `tailwind.config.ts`                | the `compact` / `roomy` boundaries, content globs |

One trap worth knowing if you touch the priority classes: Tailwind only emits a
class it has literally seen in a scanned file. A class built with a template
string, or moved to a directory the `content` globs do not cover, produces
markup that looks right in the DOM with no CSS behind it — the column simply
never comes back, and nothing warns. `lib/` is in the content globs for this
reason, and `tests/unit/responsive-data-table.test.tsx` pins both halves.
