// Primary nav model (capability-model-spec R2 · nav). Data + the ONE filter
// every nav/menu surface runs, kept out of the client component so it is unit-
// testable and so the both-states matrix can assert nav-absent-when-off.
//
// Rule (step 4): every nav/menu entry that routes into a capability carries
// `requiresFlag`. An entry with no flag is core/kernel and always shows. The
// filter is the single enforcement point — a hidden link is additive to the
// route/API 404 (lib/capabilities/guard.ts), never a substitute for it: hiding
// the affordance is UX, the 404 is what actually makes an off capability inert.
//
// Client-safe: imports only the flags predicate (config-only), no registry, no
// next/server — so it bundles into the client nav without pulling either in.

import { isCapabilityEnabled } from "@/lib/capabilities/flags";

export type NavItem = {
  href: string;
  label: string;
  /** Capability flag this entry belongs to; absent = core/kernel (always shown). */
  requiresFlag?: string;
};

/** The signed-in primary nav. Current entries are all core (no capability tab
 * exists yet); a future payments/booking/comms entry sets `requiresFlag`. */
export const PRIMARY_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/account", label: "Account" },
];

/**
 * Nav items visible under the live flag posture: a capability-flagged entry
 * appears iff its capability is on. Every nav/menu surface filters through this
 * (or isCapabilityEnabled directly for a one-off link/button) so no affordance
 * routing into an off capability is ever rendered.
 */
export function visibleNavItems(items: NavItem[] = PRIMARY_NAV): NavItem[] {
  return items.filter((item) => isCapabilityEnabled(item.requiresFlag));
}
