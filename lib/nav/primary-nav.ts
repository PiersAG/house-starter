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
import type { CapabilityFlag } from "@/config/capabilities";

export type NavItem = {
  href: string;
  label: string;
  /** Capability flag this entry belongs to; absent = core/kernel (always shown). */
  requiresFlag?: string;
};

/** Core/kernel entries — always shown (no capability flag). */
const CORE_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/account", label: "Account" },
];

/**
 * Nav entries each capability owns (steps 7–9). Registered here — not yet built
 * as pages — so the both-states matrix asserts nav-absent-when-OFF against REAL
 * entries, and a capability's tab appears automatically once its flag flips on.
 * Each entry's `href` sits under the capability's CAPABILITY_ROUTES prefix
 * (lib/capabilities/routes.ts), so with the flag OFF the link is hidden AND the
 * route 404s — the two enforcement surfaces stay consistent. Placeholder
 * destinations until the feature is built; hidden in every default (all-off)
 * build, so the live nav is unchanged today.
 */
export const CAPABILITY_NAV: Record<CapabilityFlag, NavItem[]> = {
  payments: [{ href: "/dashboard/payments", label: "Payments", requiresFlag: "payments" }],
  booking: [{ href: "/dashboard/bookings", label: "Bookings", requiresFlag: "booking" }],
  comms: [{ href: "/dashboard/messages", label: "Messages", requiresFlag: "comms" }],
};

/** The signed-in primary nav: core entries plus every capability's registered
 * entries. Capability entries are filtered out by `visibleNavItems` whenever
 * their flag is off (the default for all three today). */
export const PRIMARY_NAV: NavItem[] = [
  ...CORE_NAV,
  ...Object.values(CAPABILITY_NAV).flat(),
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
