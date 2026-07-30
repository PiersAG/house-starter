// Per-app CAPABILITY feature flags — the ONLY file a per-app build edits to
// turn capabilities on or off. Capabilities are the exposed switches an app
// varies on (capability-model-spec §2 · Capabilities); they are brief- and
// archetype-selected. Kernel switches (auth, subscription_billing, settings,
// nav) live in config/kernel.ts and are NOT edited here — they are hidden and
// permanently on.
//
// The settings registry hides any definition whose `requiresFlag` is not
// enabled (settings-registry-spec §4/§5), so a capability's settings ship
// dormant until that capability is built and turned on.
//
// house-starter default posture:
//   • payments OFF — CLIENT PAYMENTS (client-pay checkout, payment requests,
//     payments-due board). NOT BUILT in this repo or in any app yet. Its
//     settings are declared (lib/settings/billing.settings.ts) so the manifest
//     shows what the capability will expose, but they stay hidden until it
//     exists. Do NOT conflate this with subscription_billing: the owner→factory
//     Stripe subscription is KERNEL (config/kernel.ts, always on) — the WP1
//     failed-payment grace window belongs to it, not to this flag.
//   • booking  OFF — capability not built yet (spec drafted).
//   • comms    OFF — spec still to follow.
//
// All three are also NOT BUILT — see `builtCapabilities` below, which is the
// machine-readable form of the three "not built" notes above and is what stops
// the control centre offering a switch that leads nowhere.
//
// A definition with no flag (core) is always enabled. A definition whose flag
// is a KERNEL flag resolves through config/kernel.ts (always on).

import { isKernelFlag, isKernelEnabled } from "@/config/kernel";

export type CapabilityFlag = "payments" | "booking" | "comms";

export const enabledCapabilities: Record<CapabilityFlag, boolean> = {
  // OFF: no client-payments feature exists in this repo (or in K9Coach) yet.
  payments: false,
  booking: false,
  comms: false,
};

/**
 * BUILT ≠ ON. Two different facts, and conflating them is what put a dead
 * switch in front of the CEO.
 *
 *   • `enabledCapabilities` above is the POSTURE — is this capability on in
 *     this app? It is brief-/archetype-selected and varies per app.
 *   • `builtCapabilities` below is whether the feature EXISTS AT ALL. It does
 *     not vary per app: a capability is built in the factory or it is not.
 *
 * A built-but-off capability is a legitimate, useful state — it is exactly what
 * the control centre exists to switch on. An UNBUILT capability has nothing to
 * switch on: `CAPABILITY_ROUTES` and `CAPABILITY_NAV` register its prefixes and
 * its menu link as enforcement scaffolding (see lib/capabilities/routes.ts), so
 * turning it on today would publish a menu link to a page that does not exist.
 * routes.ts already says "turning a capability ON is only valid once its
 * feature exists" — this record is that sentence made machine-readable, so the
 * control centre can refuse instead of the CEO discovering it as a 404.
 *
 * WHEN A CAPABILITY SHIPS, THIS IS THE ONE EDIT: flip its entry here to `true`,
 * in the same PR that lands the feature. The switch becomes offerable
 * everywhere at once. The type is Record<CapabilityFlag, boolean>, so a new
 * capability flag cannot be added without deciding this for it.
 *
 * NOTE — this does NOT gate `isFlagEnabled` below, deliberately. The both-states
 * matrix (capability-model-spec R3) flips a flag ON in a throwaway checkout to
 * prove the settings/nav/route scaffolding really works; gating flag resolution
 * on built-ness would make that ON leg prove nothing. Built-ness constrains what
 * may be TURNED ON (an authoring-time decision, enforced by the control centre
 * and by the admission test), not how a flag RESOLVES at runtime.
 */
export const builtCapabilities: Record<CapabilityFlag, boolean> = {
  // Client-pay checkout, payment requests, payments-due board. Not built.
  payments: false,
  // Calendar, availability model, booking records. Not built (spec drafted).
  booking: false,
  // Message storage and sending schedule. Not built (spec still to follow).
  comms: false,
};

/**
 * True when a capability's feature actually exists in the factory, so offering
 * a switch for it is honest. An unknown flag is treated as NOT built, so a
 * stray name can never be offered as a working switch.
 */
export function isCapabilityBuilt(flag: string | null | undefined): boolean {
  return typeof flag === "string" && builtCapabilities[flag as CapabilityFlag] === true;
}

/**
 * True when a definition's `requiresFlag` is satisfied. Resolution order:
 *   1. No flag (core) → always enabled.
 *   2. A kernel flag → config/kernel.ts (always on in a real build; only a
 *      throwaway CI checkout can flip one off).
 *   3. A capability flag → the posture above.
 * An unknown flag is treated as disabled rather than throwing, so a stray
 * registration can never silently expose a setting.
 */
export function isFlagEnabled(requiresFlag: string | null | undefined): boolean {
  if (!requiresFlag) return true;
  if (isKernelFlag(requiresFlag)) return isKernelEnabled(requiresFlag);
  return enabledCapabilities[requiresFlag as CapabilityFlag] === true;
}
