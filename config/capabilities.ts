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
