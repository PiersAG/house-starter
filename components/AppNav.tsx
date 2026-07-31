"use client";

// The primary navigation: one component, two arrangements (card 2.3.49).
//
// Rendered ONCE per route segment by app/dashboard/layout.tsx and
// app/account/layout.tsx — never imported into an individual page. That is what
// makes every page under those segments (dogs, sessions, settings, and anything
// added later) inherit the nav instead of each page having to remember it.
//
// ── THE TWO ARRANGEMENTS, AND THE ONE BOUNDARY BETWEEN THEM ────────────────
// Below `roomy` it is a BOTTOM TAB BAR: fixed to the bottom of the screen,
// tabs of equal width, thumb-reachable. At `roomy` and above it is the row
// along the top of the page it has always been.
//
// The switch is a container query on this component's OWN container, so it is:
//
//   ONE COMPONENT. Not a <MobileNav/> and a <DesktopNav/>. Two components drift
//   — they are edited on different days and the mobile one quietly loses the
//   link the desktop one gained. Here the links are mapped ONCE and only the
//   arrangement branches, so a new capability's nav entry cannot appear in one
//   form and not the other.
//
//   NO JAVASCRIPT DECIDING WIDTH. No useMediaQuery, no matchMedia, no resize
//   listener. Those cannot know the width during server rendering, so the first
//   paint is a guess and the correction is a visible flash — the tab bar
//   appearing and then jumping to a row. A container query is resolved by the
//   browser at layout time, so the server's HTML is already correct.
//
//   ASKING THE CONTAINER, NOT THE WINDOW. `@container/appnav` is declared here,
//   so the nav adapts to the space IT is given. Put it in a sidebar tomorrow
//   and it becomes the tab-bar form because the sidebar is narrow — which is
//   right, and which a `md:` class could never do, because `md:` is a claim
//   about the window.
//
// The boundary is `roomy` (40rem) — see tailwind.config.ts. The layouts use the
// SAME name for the content padding that clears the fixed bar, so the two
// cannot drift apart; a test asserts they match.
//
// ── WHY A TAB BAR AND NOT A HAMBURGER ──────────────────────────────────────
// Decided, not defaulted: a bottom tab bar keeps every destination one
// thumb-tap away and visible. A drawer hides the information architecture
// behind a second tap and an animation, which costs discovery for the small
// number of top-level destinations an app of this shape has.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { visibleNavItems, type NavItem } from "@/lib/nav/primary-nav";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Nav items and their capability filtering live in lib/nav/primary-nav.ts (data
// + the one filter, unit-testable). A capability-gated entry carries
// `requiresFlag` and is dropped when its flag is off — additive to the route/API
// 404 (R2), never a substitute.

/**
 * How many destinations the bar shows before the rest fold into "More".
 *
 * ── WHY A FIXED BUDGET RATHER THAN MEASURING ───────────────────────────────
 * Measuring the bar and deciding what fits means reading layout in JavaScript,
 * which means the first paint is wrong and corrects itself visibly — the exact
 * flash this component exists to avoid. A fixed budget is decided at render
 * time, is identical on the server and the client, and cannot overflow, because
 * it never puts more than five items in the bar however many the capability
 * flags produce.
 *
 * Five is the practical ceiling for a thumb-reachable bar at 320px: five tabs
 * leave ~64px each, comfortably past the 44px touch-target minimum.
 *
 * THE SAME PARTITION APPLIES AT BOTH WIDTHS, deliberately. Moving an item
 * between the bar and the menu based on width would need JavaScript to know the
 * width (a flash), or the item rendered twice and CSS-hidden (a duplicate link
 * in the accessibility tree and a duplicate tab stop). So the rule is a
 * property of the nav rather than of the screen: at most five top-level
 * destinations, the rest under More, at every width.
 */
export const MAX_TABS = 5;

/** Split the links into the ones the bar shows and the ones "More" holds. */
export function partitionNav(items: NavItem[]): { tabs: NavItem[]; overflow: NavItem[] } {
  if (items.length <= MAX_TABS) return { tabs: items, overflow: [] };
  // One slot is spent on the More trigger itself, so the bar shows MAX_TABS - 1
  // real destinations — otherwise adding More would push the count to six.
  return { tabs: items.slice(0, MAX_TABS - 1), overflow: items.slice(MAX_TABS - 1) };
}

export function AppNav({ items }: { items?: NavItem[] } = {}) {
  const pathname = usePathname();
  // `items` is a seam for tests and for any future surface needing a different
  // set; production callers pass nothing and get the real, flag-filtered nav.
  const links = items ?? visibleNavItems();
  const { tabs, overflow } = partitionNav(links);
  const overflowActive = overflow.some((i) => i.href === pathname);

  /** One destination, in whichever arrangement is currently rendering. The
   *  touch target, the focus ring and aria-current are set HERE — once — so a
   *  rearrange cannot drop them from one form and keep them in the other. */
  const tab = (item: NavItem, active: boolean) => (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        // Shared by both arrangements.
        "flex min-h-11 items-center justify-center rounded font-medium",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        // Bar arrangement — the default, i.e. narrow.
        "h-full w-full flex-col gap-0.5 px-1 py-2 text-fluid-xs",
        // Row arrangement, at `roomy` and above.
        "@roomy/appnav:h-auto @roomy/appnav:w-auto @roomy/appnav:flex-row",
        "@roomy/appnav:justify-start @roomy/appnav:gap-0 @roomy/appnav:px-3",
        "@roomy/appnav:py-1.5 @roomy/appnav:text-fluid-sm",
        active
          ? "text-primary @roomy/appnav:bg-surface @roomy/appnav:text-text-primary"
          : "text-text-secondary hover:bg-surface hover:text-text-primary",
      )}
    >
      {/* The active marker is a rule above the label in the bar and a filled
          pill in the row, so "which page am I on" is never colour alone
          (WCAG 1.4.1). Hidden from assistive tech — aria-current already
          says it, and saying it twice is noise. */}
      <span
        aria-hidden
        className={cn(
          "h-0.5 w-6 rounded-full @roomy/appnav:hidden",
          active ? "bg-primary" : "bg-transparent",
        )}
      />
      <span className="max-w-full truncate">{item.label}</span>
    </Link>
  );

  return (
    <nav aria-label="Primary" className="@container/appnav">
      <div
        className={cn(
          // BAR: pinned to the bottom, above page content, clear of the iOS
          // home indicator. `inset-x-0` rather than a width, so it spans the
          // screen however wide that is.
          "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background",
          "pb-[env(safe-area-inset-bottom)]",
          // ROW: back into normal flow at the top, rule underneath.
          "@roomy/appnav:static @roomy/appnav:z-auto @roomy/appnav:border-t-0",
          "@roomy/appnav:border-b @roomy/appnav:bg-transparent @roomy/appnav:pb-0",
        )}
      >
        <ul
          className={cn(
            "mx-auto flex w-full list-none items-stretch",
            // Bar: equal-width tabs filling the screen.
            "h-16 gap-0 px-0",
            // Row: the app's centred column, items sized to their labels.
            "@roomy/appnav:h-auto @roomy/appnav:max-w-2xl @roomy/appnav:items-center",
            "@roomy/appnav:gap-1 @roomy/appnav:px-4 @roomy/appnav:pt-4 @roomy/appnav:pb-2",
          )}
        >
          {tabs.map((item) => (
            <li key={item.href} className="flex-1 @roomy/appnav:flex-none">
              {tab(item, pathname === item.href)}
            </li>
          ))}

          {overflow.length > 0 ? (
            <li className="flex-1 @roomy/appnav:flex-none">
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`More destinations (${overflow.length})`}
                  className={cn(
                    "flex min-h-11 w-full items-center justify-center rounded font-medium",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    "h-full flex-col gap-0.5 px-1 py-2 text-fluid-xs",
                    "@roomy/appnav:h-auto @roomy/appnav:w-auto @roomy/appnav:flex-row",
                    "@roomy/appnav:gap-0 @roomy/appnav:px-3 @roomy/appnav:py-1.5",
                    "@roomy/appnav:text-fluid-sm",
                    overflowActive
                      ? "text-primary @roomy/appnav:bg-surface @roomy/appnav:text-text-primary"
                      : "text-text-secondary hover:bg-surface hover:text-text-primary",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "h-0.5 w-6 rounded-full @roomy/appnav:hidden",
                      overflowActive ? "bg-primary" : "bg-transparent",
                    )}
                  />
                  <span className="max-w-full truncate">More</span>
                </DropdownMenuTrigger>
                {/* side="top": in the bar arrangement there is nothing below to
                    open into. Radix flips it automatically where there is. */}
                <DropdownMenuContent side="top" align="end" className="min-w-44">
                  {overflow.map((item) => (
                    <DropdownMenuItem key={item.href} asChild>
                      <Link
                        href={item.href}
                        aria-current={pathname === item.href ? "page" : undefined}
                        className="min-h-11 w-full cursor-pointer text-fluid-sm"
                      >
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ) : null}
        </ul>
      </div>
    </nav>
  );
}
