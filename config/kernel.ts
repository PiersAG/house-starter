// KERNEL feature flags (capability-model-spec §2 · Kernel). The kernel is the
// set of parts an app is not an app without — `auth`, `subscription_billing`
// (the owner→factory subscription), `settings` (the registry + resolver + UI)
// and `nav` (the layout-provided shell). Every kernel part carries a switch so
// that OFF stays a *testable* state and the kernel cannot quietly grow
// un-switchable behaviour — but no automated build path turns one off.
//
// HIDDEN-SWITCH MECHANISM (the important part):
//   • Kernel flags are PERMANENTLY ON in every automated build. They are absent
//     from the brief, from archetype presets and from the scaffold's write path
//     — nothing the factory generates flips one.
//   • The ONLY way a kernel flag goes OFF is CODEGEN rewriting this file in a
//     THROWAWAY CI CHECKOUT — the both-states matrix (capability-model-spec R3)
//     flips a flag, runs the suite to prove OFF is inert, and discards the
//     checkout. The flip never reaches a deployed artifact.
//   • A kernel flag is NEVER a runtime environment variable. An env-var auth (or
//     billing) kill-switch readable in production is a SECURITY DEFECT: it turns
//     a deploy-time misconfiguration or a leaked env into an access-control
//     bypass. Kernel state is compiled in, not resolved at request time. This is
//     a rejected design, recorded here so it is not re-proposed.
//
// Distinct from config/capabilities.ts: capability flags (payments, booking,
// comms) ARE brief/archetype-selected and vary per app. Kernel flags do not.

export type KernelFlag = "auth" | "subscription_billing" | "settings" | "nav";

/**
 * Kernel posture. ON in every automated build. Codegen in a throwaway CI
 * checkout is the only writer (both-states matrix); never edited by a per-app
 * build, never overridden by an environment variable.
 */
export const enabledKernel: Record<KernelFlag, boolean> = {
  auth: true,
  subscription_billing: true,
  settings: true,
  nav: true,
};

const KERNEL_FLAGS = new Set<string>(Object.keys(enabledKernel));

/** True when `flag` names a kernel part (as opposed to a capability or core). */
export function isKernelFlag(flag: string | null | undefined): flag is KernelFlag {
  return typeof flag === "string" && KERNEL_FLAGS.has(flag);
}

/**
 * Whether a kernel part is enabled. True in every build; false only inside a
 * throwaway CI checkout whose config was rewritten by the both-states matrix.
 * An unknown flag is treated as disabled rather than throwing.
 */
export function isKernelEnabled(flag: string | null | undefined): boolean {
  return isKernelFlag(flag) && enabledKernel[flag] === true;
}
