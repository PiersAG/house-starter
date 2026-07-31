"use client";

// Minimal primary nav shared across the signed-in pages so Dashboard, Settings
// and Account are reachable from each other.
//
// Rendered ONCE per route segment by app/dashboard/layout.tsx and
// app/account/layout.tsx — never imported into an individual page. That is what
// makes every page under those segments (dogs, sessions, settings, and anything
// added later) inherit the nav instead of each page having to remember it.
//
// Self-contained: it carries its own centred max-w-2xl column and horizontal
// padding so it lines up with the pages' `max-w-2xl p-4 sm:p-6` main element
// and a layout can render it bare.
//
// ── THE WORKED EXAMPLE FOR THE RESPONSIVE FOUNDATION (card 2.3.15) ──────────
// This is the copyable reference for the pattern in docs/responsive.md. Three
// things to take from it:
//
//   1. THE COMPONENT DECLARES ITS OWN CONTAINER. `@container/appnav` on the
//      <nav> means everything inside asks how much room THE NAV has, not how
//      wide the window is. Drop this nav in a sidebar tomorrow and it adapts
//      correctly with no edit — which is exactly what a `md:` class could not
//      do, because `md:` is a claim about the window.
//
//   2. ONE BOUNDARY, BOTH ARRANGEMENTS, ONE COMPONENT. Below `compact` the
//      links stack full-width; at `compact` and above they are a horizontal
//      row. There is no second component, no mobile fork, and no JavaScript:
//      the browser switches arrangements in CSS, so it is correct on the
//      server's first paint and there is no hydration flash.
//
//   3. SIZES ARE FLUID. `text-fluid-sm` and `gap-fluid-3xs` interpolate; they
//      do not snap at a breakpoint.
//
// INTERIM ARRANGEMENT, DELIBERATELY. The narrow form here is a plain stack.
// Card 2.3.49 replaces it with a real bottom tab bar — at THIS boundary, in
// THIS component. That is the point of the pattern: the rearrange has a home
// to grow into, and no whole-screen layout fork was needed to get there.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { visibleNavItems } from "@/lib/nav/primary-nav";

// Nav items and their capability filtering live in lib/nav/primary-nav.ts (data
// + the one filter, unit-testable). A capability-gated entry carries
// `requiresFlag` and is dropped when its flag is off — additive to the route/API
// 404 (R2), never a substitute. Current entries are all core.

export function AppNav() {
  const pathname = usePathname();
  const links = visibleNavItems();
  return (
    <nav
      aria-label="Primary"
      className="@container/appnav mx-auto w-full max-w-2xl border-b border-border px-4 pt-4 pb-2 sm:px-6"
    >
      {/* Narrow: a full-width stack. `compact` and wider: a wrapping row.
          The whole switch is these two lines. */}
      <div className="flex flex-col gap-fluid-3xs @compact/appnav:flex-row @compact/appnav:flex-wrap @compact/appnav:gap-1">
        {links.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              /* min-h-11 is the 44px touch target and holds in BOTH
                 arrangements — a rearrange must never cost accessibility.
                 flex/items-center keeps the label centred vertically now that
                 the stacked form is a full-width block. */
              className={`flex min-h-11 items-center rounded px-3 py-1.5 text-fluid-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                active
                  ? "bg-surface text-text-primary"
                  : "text-text-secondary hover:bg-surface hover:text-text-primary"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
