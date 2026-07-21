// Seed the setting_definitions catalogue from the merged registry
// (settings-registry-spec §4 · "house-starter merges declarations into the seed
// at build"). Run as part of the one true migration path (lib/migrate.ts) so
// every migrated database — dev, CI, and each tenant — carries the current
// catalogue. Idempotent: an existing key is UPDATED to the current declaration,
// so re-running keeps the table in sync with the code, never duplicated.
//
// Uses the raw libSQL Client (the migration layer's currency), not Drizzle, so
// seeding stays inside the single migrate() entry point.

import type { Client, InValue } from "@libsql/client";
import { ALL_DEFINITIONS } from "@/lib/settings/registry";
import { isCapabilityEnabled } from "@/lib/capabilities/flags";
import type { SettingDefinition } from "@/lib/settings/types";

const UPSERT_SQL = `
INSERT INTO setting_definitions (
  key, capability, functional_group, label, description, value_type,
  enum_values, factory_default, bounds, owner_editable, client_scoped, requires_flag
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  capability = excluded.capability,
  functional_group = excluded.functional_group,
  label = excluded.label,
  description = excluded.description,
  value_type = excluded.value_type,
  enum_values = excluded.enum_values,
  factory_default = excluded.factory_default,
  bounds = excluded.bounds,
  owner_editable = excluded.owner_editable,
  client_scoped = excluded.client_scoped,
  requires_flag = excluded.requires_flag;
`;

function argsFor(def: SettingDefinition): InValue[] {
  return [
    def.key,
    def.capability,
    def.functionalGroup,
    def.label,
    def.description,
    def.valueType,
    def.enumValues ? JSON.stringify(def.enumValues) : null,
    JSON.stringify(def.factoryDefault ?? null),
    def.bounds ? JSON.stringify(def.bounds) : null,
    def.ownerEditable === false ? 0 : 1,
    def.clientScoped === true ? 1 : 0,
    def.requiresFlag ?? null,
  ];
}

/**
 * Upsert every ENABLED definition into setting_definitions. Idempotent.
 *
 * R2: a key whose capability is off is not seeded — an OFF capability's keys
 * cannot be read, written, OR seeded. Core keys (no flag) and kernel keys
 * (always on) are always seeded. When a capability is later turned on, the
 * migration re-runs this seed and its keys appear (idempotent upsert). A row
 * seeded while a flag was on and then turned off is left in place — harmless,
 * because enforcement is at the read/write path (resolver/values), not this
 * catalogue table, which nothing reads for gating.
 */
export async function seedSettingDefinitions(client: Client): Promise<void> {
  const enabled = ALL_DEFINITIONS.filter((def) => isCapabilityEnabled(def.requiresFlag));
  await client.batch(
    enabled.map((def) => ({ sql: UPSERT_SQL, args: argsFor(def) })),
    "write",
  );
}
