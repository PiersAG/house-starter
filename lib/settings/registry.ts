// Settings registry — the merge point (settings-registry-spec §4).
//
// Each capability ships its own `*.settings.ts`; this module concatenates them
// into ONE catalogue and guards against duplicate keys at module load, so a
// collision is a build-time failure, not a silent last-writer-wins. The seed
// (lib/settings/seed.ts) writes ALL_DEFINITIONS into setting_definitions; the
// resolver and UI look definitions up here or from the seeded table.

import type { SettingDefinition } from "@/lib/settings/types";
import { coreSettings } from "@/lib/settings/core.settings";
import { billingSettings } from "@/lib/settings/billing.settings";
import { bookingSettings } from "@/lib/settings/booking.settings";
import { commsSettings } from "@/lib/settings/comms.settings";

/** Every capability's declarations, in display order (core first). */
const CONTRIBUTIONS: SettingDefinition[] = [
  ...coreSettings,
  ...billingSettings,
  ...bookingSettings,
  ...commsSettings,
];

function buildRegistry(defs: SettingDefinition[]): Map<string, SettingDefinition> {
  const map = new Map<string, SettingDefinition>();
  for (const def of defs) {
    if (map.has(def.key)) {
      throw new Error(
        `lib/settings/registry.ts: duplicate setting key ${JSON.stringify(def.key)}. ` +
          `Each key must be declared exactly once across the capability settings.ts files.`,
      );
    }
    map.set(def.key, def);
  }
  return map;
}

const REGISTRY = buildRegistry(CONTRIBUTIONS);

/** All definitions, in declaration order. */
export const ALL_DEFINITIONS: readonly SettingDefinition[] = CONTRIBUTIONS;

/** Look up a definition by key. Returns undefined for an unknown key. */
export function getDefinition(key: string): SettingDefinition | undefined {
  return REGISTRY.get(key);
}

/** True when the key is a registered setting. */
export function isKnownKey(key: string): boolean {
  return REGISTRY.has(key);
}
