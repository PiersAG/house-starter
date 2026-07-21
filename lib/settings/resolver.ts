// The settings resolver (settings-registry-spec §2/§4) — the ONE code path
// every capability uses to read a configurable behaviour. Never read a setting
// from an env var or a direct table query; always come through here.
//
// Three levels, most-specific-wins, fall through on absence:
//
//     client preference  →  owner override  →  factory default
//
// Client preference is only consulted for a client-scoped definition and only
// when a clientId is supplied. Absence at any level falls through; there is no
// copying of values between levels.
//
// Signature note (flagged deviation): the spec writes `getSetting(key, {
// clientId })`. The house-starter convention is dependency injection with the
// database as the first argument (lib/users.ts, lib/billing/*), so the
// implemented signature is `getSetting(db, key, { clientId })`. The three-level
// semantics are exactly as specced.

import { getDefinition } from "@/lib/settings/registry";
import { getStoredValue } from "@/lib/settings/values";
import { isCapabilityEnabled } from "@/lib/capabilities/flags";
import { UnknownSettingError, CapabilityDisabledError } from "@/lib/settings/errors";
import type { AppDatabase } from "@/lib/users";
import type { SettingSource } from "@/lib/settings/types";

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
  db: AppDatabase,
  key: string,
  opts: ResolveOptions = {},
): Promise<{ value: unknown; source: SettingSource }> {
  const def = getDefinition(key);
  if (!def) throw new UnknownSettingError(key);
  // R2: an off capability's key reads as absent, at the one true read path.
  // Kernel flags (e.g. subscription_billing) are always on, so the paid-gate's
  // read of billing.subscription_grace_days is unaffected.
  if (!isCapabilityEnabled(def.requiresFlag)) throw new CapabilityDisabledError(key);

  // 1. Client preference — only for client-scoped settings with a clientId.
  if (def.clientScoped && opts.clientId) {
    const clientValue = await getStoredValue(db, key, "client", opts.clientId);
    if (clientValue !== undefined) {
      return { value: clientValue, source: "client" };
    }
  }

  // 2. Owner override.
  const ownerValue = await getStoredValue(db, key, "owner");
  if (ownerValue !== undefined) {
    return { value: ownerValue, source: "owner" };
  }

  // 3. Factory default — always present.
  return { value: def.factoryDefault, source: "factory" };
}

/**
 * The resolver's primary form: the effective value only. Generic over the
 * caller's expected type — the definition owns the true shape, so the cast is
 * the caller asserting the type it authored.
 */
export async function getSetting<T = unknown>(
  db: AppDatabase,
  key: string,
  opts: ResolveOptions = {},
): Promise<T> {
  const { value } = await resolveSetting(db, key, opts);
  return value as T;
}
