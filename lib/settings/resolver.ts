// The settings resolver (settings-registry-spec §2/§4) — the ONE code path
// every capability uses to read a configurable behaviour. Never read a setting
// from an env var or a direct table query; always come through here.
//
// FOUR levels, most-specific-wins, fall through on absence — and they span TWO
// DATABASES, which is the point:
//
//     client preference  →  owner override  →  operator value  →  factory default
//     └──────────── tenant database ────────┘  └─ catalog ─┘   └─ code ─┘
//
// The first two are one customer's answer and live in that customer's own
// database. The third is the answer for the whole app — trial length, the app's
// name, its outbound-mail identity — and lives in the control plane, where no
// request path can write it. The fourth is the value the template ships.
//
// WHY THE SPLIT EXISTS (finding 1). `setting_values` used to live in the CATALOG
// with primary key `(key, scope, client_id)` and no tenant column, so an owner
// row was ONE GLOBAL ROW: whichever signed-in account wrote last set the value
// every tenant then read. Moving the tenant levels into the tenant database
// removes the class rather than filtering it — there is no `where tenant_id = ?`
// to forget, because the other customer's row is not in the database being
// queried. settings-registry-spec §3 always said tenant DB; this implements it.
//
// Client preference is only consulted for a client-scoped definition and only
// when a clientId is supplied. Absence at any level falls through; there is no
// copying of values between levels.
//
// Signature note (flagged deviation): the spec writes `getSetting(key, {
// clientId })`. The house-starter convention is dependency injection with the
// database as the first argument (lib/users.ts, lib/billing/*), so the
// implemented signature is `getSetting(stores, key, { clientId })` — `stores`
// rather than a bare `db` because a resolution now legitimately touches two
// databases. The level semantics are exactly as specced.

import { getDefinition } from "@/lib/settings/registry";
import { getStoredValue } from "@/lib/settings/values";
import { getOperatorValue } from "@/lib/settings/operator";
import { isCapabilityEnabled } from "@/lib/capabilities/flags";
import { UnknownSettingError, CapabilityDisabledError } from "@/lib/settings/errors";
import type { SettingSource, SettingsStores } from "@/lib/settings/types";

export interface ResolveOptions {
  /** The client whose preference should win for a client-scoped setting. */
  clientId?: string;
}

// Re-exported for callers that import it from here (its historical home).
export { UnknownSettingError } from "@/lib/settings/errors";

/**
 * Resolve the effective value of `key`, plus where it came from. Throws
 * UnknownSettingError for a key with no definition, and CapabilityDisabledError
 * (a subclass — so it is caught as "absent" too) for a key whose capability is
 * off. An OFF capability's key is not readable (R2), not merely hidden.
 */
export async function resolveSetting(
  stores: SettingsStores,
  key: string,
  opts: ResolveOptions = {},
): Promise<{ value: unknown; source: SettingSource }> {
  const def = getDefinition(key);
  if (!def) throw new UnknownSettingError(key);
  // R2: an off capability's key reads as absent, at the one true read path.
  // Kernel flags (e.g. subscription_billing) are always on, so the paid-gate's
  // read of billing.subscription_grace_days is unaffected.
  if (!isCapabilityEnabled(def.requiresFlag)) throw new CapabilityDisabledError(key);

  // An operatorOnly key SKIPS the tenant plane entirely — it is not merely
  // unwritable there, it is not read from there. So a stale tenant row (from a
  // key that was per-tenant before it was reclassified, or written by a direct
  // caller that bypassed validation) cannot override an operator decision. The
  // control plane is the only authority for these keys, on read as on write.
  if (!def.operatorOnly && stores.tenant) {
    // 1. Client preference — only for client-scoped settings with a clientId.
    if (def.clientScoped && opts.clientId) {
      const clientValue = await getStoredValue(
        stores.tenant,
        key,
        "client",
        opts.clientId,
      );
      if (clientValue !== undefined) {
        return { value: clientValue, source: "client" };
      }
    }

    // 2. Owner override — this tenant's own answer, from this tenant's own DB.
    const ownerValue = await getStoredValue(stores.tenant, key, "owner");
    if (ownerValue !== undefined) {
      return { value: ownerValue, source: "owner" };
    }
  }

  // 3. Operator value — the app-wide answer, set only from outside the app.
  const operatorValue = await getOperatorValue(stores.catalog, key);
  if (operatorValue !== undefined) {
    return { value: operatorValue, source: "operator" };
  }

  // 4. Factory default — always present.
  return { value: def.factoryDefault, source: "factory" };
}

/**
 * The resolver's primary form: the effective value only. Generic over the
 * caller's expected type — the definition owns the true shape, so the cast is
 * the caller asserting the type it authored.
 */
export async function getSetting<T = unknown>(
  stores: SettingsStores,
  key: string,
  opts: ResolveOptions = {},
): Promise<T> {
  const { value } = await resolveSetting(stores, key, opts);
  return value as T;
}
