// Settings registry — shared types (settings-registry-spec §3/§4).
//
// A SettingDefinition is the in-code, authored form of a `setting_definitions`
// row. Each capability ships an array of these in its own `*.settings.ts`; the
// registry (lib/settings/registry.ts) merges them and the seed writes them into
// the catalogue table. Capability code never reads a setting except through the
// resolver (lib/settings/resolver.ts).

import type { AppDatabase } from "@/lib/users";

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
  /**
   * Defaults to false. true = an OPERATOR/CEO control, not a customer's setting.
   *
   * This is a stronger statement than `ownerEditable: false`. That one says "the
   * factory default stands and no customer may override it"; this one says the
   * key belongs to whoever RUNS the app — trial length, comp accounts, the app's
   * own name and outbound-mail identity — and is settable, but only from outside
   * every request path.
   *
   * The consequences are enforced in three places, and they compose:
   *   - lib/settings/resolver.ts  reads it at OPERATOR scope from the catalog and
   *                              never consults a tenant database for it;
   *   - lib/settings/validation.ts refuses every owner and client write to it;
   *   - lib/settings/service.ts   omits it from every generated view.
   * So it renders on no page and answers no write. The only writer is
   * scripts/set-operator-setting.ts (see lib/settings/operator.ts) — the control
   * is ABSENT from the app's request paths rather than exposed and then guarded.
   */
  operatorOnly?: boolean;
  /** Defaults to false. true = a per-client preference may override. */
  clientScoped?: boolean;
  /** Capability feature flag; hidden in the UI when the flag is off. */
  requiresFlag?: string;
}

/** The scope at which a chosen value is stored. */
export type SettingScope = "owner" | "client";

/**
 * Where an effective value came from — surfaced to the UI. Most-specific first:
 * a per-client preference beats the tenant's owner override, which beats the
 * operator's global value, which beats the factory default in code.
 */
export type SettingSource = "client" | "owner" | "operator" | "factory";

/**
 * The databases a settings read may need. Two planes, and which one a value
 * lives in is the whole of finding 1.
 *
 * `tenant` holds `setting_values` — one customer's chosen values, in THEIR OWN
 * database, so another customer's rows are not filtered out, they are not
 * present. `catalog` holds `operator_setting_values` — the control plane.
 *
 * `tenant` is OPTIONAL because a real read happens without one: the root
 * layout's generateMetadata resolves `core.app_name` on anonymous requests (the
 * login page, the marketing pages, error pages) where there is no session and
 * therefore no tenant. Such a read resolves operator → factory only; it does not
 * fall back to some default tenant's database, because there is no such thing.
 */
export interface SettingsStores {
  /** This request's tenant database. Absent on an anonymous request. */
  tenant?: AppDatabase;
  /** The control-plane database. Always required. */
  catalog: AppDatabase;
}
