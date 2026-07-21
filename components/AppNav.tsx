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

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isCapabilityEnabled } from "@/lib/capabilities/flags";

// Each link may carry `requiresFlag`: a capability-gated nav item is filtered
// out when its flag is off, through the same substrate the route/API 404 uses.
// This is additive to the 404 (R2) — a hidden link is polish; the guard in
// lib/capabilities/guard.ts is the enforcement. Current links are all core
// (no flag) so every one shows; capability nav items (e.g. a future payments
// or booking tab) set `requiresFlag` and disappear automatically when off.
type NavLink = { href: string; label: string; requiresFlag?: string };

const LINKS: NavLink[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/account", label: "Account" },
];

export function AppNav() {
  const pathname = usePathname();
  const links = LINKS.filter((l) => isCapabilityEnabled(l.requiresFlag));
  return (
    <nav
      aria-label="Primary"
      className="mx-auto flex w-full max-w-2xl flex-wrap gap-1 border-b border-border px-4 pt-4 pb-2 sm:px-6"
    >
      {links.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`min-h-11 rounded px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              active
                ? "bg-surface text-text-primary"
                : "text-text-secondary hover:bg-surface hover:text-text-primary"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
