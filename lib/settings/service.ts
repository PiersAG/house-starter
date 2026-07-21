// Settings service — turns the registry + stored values into the shape the
// generated UI renders (settings-registry-spec §5). The owner settings page and
// the client account view both call this; neither hand-builds a settings screen.
//
// Flag filtering lives here: a definition whose `requiresFlag` is off is absent
// from every view, so booking/comms settings stay hidden until their capability
// is enabled in config/capabilities.ts.

import { ALL_DEFINITIONS } from "@/lib/settings/registry";
import { resolveSetting } from "@/lib/settings/resolver";
import { isCapabilityEnabled } from "@/lib/capabilities/flags";
import type { AppDatabase } from "@/lib/users";
import type { SettingDefinition, SettingSource } from "@/lib/settings/types";

export interface EffectiveSetting {
  key: string;
  capability: string;
  functionalGroup: string;
  label: string;
  description: string;
  valueType: string;
  enumValues?: string[];
  bounds?: { min?: number; max?: number };
  /** The value in force, after three-level resolution. */
  effectiveValue: unknown;
  /** Which level supplied it. */
  source: SettingSource;
  /** true when factory-locked (owner_editable === false). */
  locked: boolean;
  clientScoped: boolean;
}

export interface FunctionalGroupView {
  functionalGroup: string;
  settings: EffectiveSetting[];
}
export interface CapabilityView {
  capability: string;
  groups: FunctionalGroupView[];
}

/**
 * Definitions visible given the current flags. `clientScoped` selects which
 * half of the registry to return: the owner page passes false (owner-facing
 * settings), the client account view passes true (per-client preferences).
 */
export function visibleDefinitions(clientScoped: boolean): SettingDefinition[] {
  return ALL_DEFINITIONS.filter(
    (def) =>
      isCapabilityEnabled(def.requiresFlag) &&
      (def.clientScoped === true) === clientScoped,
  );
}

/** Group a flat list into capability → functional_group, preserving order. */
function group(settings: EffectiveSetting[]): CapabilityView[] {
  const caps: CapabilityView[] = [];
  for (const s of settings) {
    let cap = caps.find((c) => c.capability === s.capability);
    if (!cap) {
      cap = { capability: s.capability, groups: [] };
      caps.push(cap);
    }
    let grp = cap.groups.find((g) => g.functionalGroup === s.functionalGroup);
    if (!grp) {
      grp = { functionalGroup: s.functionalGroup, settings: [] };
      cap.groups.push(grp);
    }
    grp.settings.push(s);
  }
  return caps;
}

async function toEffective(
  db: AppDatabase,
  def: SettingDefinition,
  clientId?: string,
): Promise<EffectiveSetting> {
  const { value, source } = await resolveSetting(db, def.key, { clientId });
  return {
    key: def.key,
    capability: def.capability,
    functionalGroup: def.functionalGroup,
    label: def.label,
    description: def.description,
    valueType: def.valueType,
    enumValues: def.enumValues,
    bounds: def.bounds,
    effectiveValue: value,
    source,
    locked: def.ownerEditable === false,
    clientScoped: def.clientScoped === true,
  };
}

/**
 * The owner settings page model: every visible owner-facing setting, resolved
 * at owner scope, grouped by capability → functional group.
 */
export async function buildOwnerSettingsView(
  db: AppDatabase,
): Promise<CapabilityView[]> {
  const defs = visibleDefinitions(false);
  const effective = await Promise.all(defs.map((def) => toEffective(db, def)));
  return group(effective);
}

/**
 * The client account view model: every visible client-scoped setting, resolved
 * for this client (their preference wins where set), grouped.
 */
export async function buildClientSettingsView(
  db: AppDatabase,
  clientId: string,
): Promise<CapabilityView[]> {
  const defs = visibleDefinitions(true);
  const effective = await Promise.all(
    defs.map((def) => toEffective(db, def, clientId)),
  );
  return group(effective);
}
