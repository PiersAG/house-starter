// Capability substrate — settings-key resolution (capability-model-spec R2/R5).
//
// The bridge between a setting KEY and its governing capability flag. Pure and
// free of next/server (so the migration/seed path, which runs under tsx, can
// import it), but it does read the registry — so it is server-side, not for a
// client bundle. The client-safe predicate is ./flags.ts.

import { getDefinition } from "@/lib/settings/registry";
import { isCapabilityEnabled } from "@/lib/capabilities/flags";

/** The capability/kernel flag governing a setting key, or null for core/unknown. */
export function flagForSettingKey(key: string): string | null {
  return getDefinition(key)?.requiresFlag ?? null;
}

/**
 * True when a setting key may be read/written/seeded: its capability is on, or
 * it is core (no flag) or kernel (always on). An UNKNOWN key returns true —
 * capability gating is not where unknown keys are rejected; the caller's own
 * unknown-key handling (UnknownSettingError, validation) owns that.
 */
export function isSettingKeyEnabled(key: string): boolean {
  const def = getDefinition(key);
  return def ? isCapabilityEnabled(def.requiresFlag) : true;
}
