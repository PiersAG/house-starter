// Per-app capability feature flags — the ONLY file a per-app build edits to
// turn capabilities on or off. The settings registry hides any definition whose
// `requiresFlag` is not enabled here (settings-registry-spec §4/§5), so booking
// and comms definitions ship dormant until their capability is built.
//
// house-starter default posture (service-archetype starter):
//   • payments ON  — billing plumbing is merged; its settings are visible.
//   • booking  OFF — capability not built yet (spec drafted).
//   • comms    OFF — spec still to follow.
//
// A capability with no flag (core) is always enabled.

export type CapabilityFlag = "payments" | "booking" | "comms";

export const enabledCapabilities: Record<CapabilityFlag, boolean> = {
  payments: true,
  booking: false,
  comms: false,
};

/**
 * True when a definition's `requiresFlag` is satisfied. A definition with no
 * flag (core) is always enabled; an unknown flag is treated as disabled rather
 * than throwing, so a stray registration can never silently expose a setting.
 */
export function isFlagEnabled(requiresFlag: string | null | undefined): boolean {
  if (!requiresFlag) return true;
  return enabledCapabilities[requiresFlag as CapabilityFlag] === true;
}
