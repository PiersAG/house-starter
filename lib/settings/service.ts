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
import type { SettingDefinition, SettingSource, SettingsStores } from "@/lib/settings/types";

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
 *
 * OPERATOR KEYS ARE ABSENT FROM BOTH. They are not rendered read-only and not
 * shown greyed out — a control the customer cannot use is still a control they
 * can see and ask about, and more importantly a rendered field is a field some
 * later change wires up. Trial length, the app's name and its mail identity
 * belong to whoever runs the service; the app's own screens are not where they
 * are set. See lib/settings/operator.ts.
 */
export function visibleDefinitions(clientScoped: boolean): SettingDefinition[] {
  return ALL_DEFINITIONS.filter(
    (def) =>
      def.operatorOnly !== true &&
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
  stores: SettingsStores,
  def: SettingDefinition,
  clientId?: string,
): Promise<EffectiveSetting> {
  const { value, source } = await resolveSetting(stores, def.key, { clientId });
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
  stores: SettingsStores,
): Promise<CapabilityView[]> {
  const defs = visibleDefinitions(false);
  const effective = await Promise.all(defs.map((def) => toEffective(stores, def)));
  return group(effective);
}

/**
 * The client account view model: every visible client-scoped setting, resolved
 * for this client (their preference wins where set), grouped.
 */
export async function buildClientSettingsView(
  stores: SettingsStores,
  clientId: string,
): Promise<CapabilityView[]> {
  const defs = visibleDefinitions(true);
  const effective = await Promise.all(
    defs.map((def) => toEffective(stores, def, clientId)),
  );
  return group(effective);
}
