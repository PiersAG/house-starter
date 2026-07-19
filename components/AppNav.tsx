"use client";

// Minimal primary nav shared across the signed-in pages so Dashboard, Settings
// and Account are reachable from each other. No shared nav existed before —
// each page carried its own inline header — so this is the standard bar; drop
// <AppNav /> directly under a page's <header>.

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/account", label: "Account" },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="mt-4 flex flex-wrap gap-1 border-b border-border pb-2"
    >
      {LINKS.map(({ href, label }) => {
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
