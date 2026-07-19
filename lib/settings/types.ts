// Settings registry — shared types (settings-registry-spec §3/§4).
//
// A SettingDefinition is the in-code, authored form of a `setting_definitions`
// row. Each capability ships an array of these in its own `*.settings.ts`; the
// registry (lib/settings/registry.ts) merges them and the seed writes them into
// the catalogue table. Capability code never reads a setting except through the
// resolver (lib/settings/resolver.ts).

/** The value shapes a setting may take. Mirrors the CHECK on value_type. */
export type SettingValueType =
  | "boolean"
  | "integer"
  | "decimal"
  | "text"
  | "enum"
  | "duration_hours"
  | "json";

/** Numeric bounds for integer / decimal / duration_hours. null = free. */
export interface SettingBounds {
  min?: number;
  max?: number;
}

/**
 * The authored definition of one configurable behaviour. `factoryDefault` is
 * the shipped value every app starts from; `ownerEditable: false` locks it.
 */
export interface SettingDefinition {
  /** Dotted key, unique across the whole registry. */
  key: string;
  capability: "core" | "billing" | "booking" | "comms";
  functionalGroup: string;
  label: string;
  description: string;
  valueType: SettingValueType;
  /** Allowed values when valueType = 'enum'. */
  enumValues?: string[];
  /** The factory default — always present, typed to the value_type. */
  factoryDefault: unknown;
  bounds?: SettingBounds;
  /** Defaults to true. false = factory-locked, no owner override permitted. */
  ownerEditable?: boolean;
  /** Defaults to false. true = a per-client preference may override. */
  clientScoped?: boolean;
  /** Capability feature flag; hidden in the UI when the flag is off. */
  requiresFlag?: string;
}

/** The scope at which a chosen value is stored. */
export type SettingScope = "owner" | "client";

/** Where an effective value came from — surfaced to the UI. */
export type SettingSource = "client" | "owner" | "factory";
