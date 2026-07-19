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
import type { AppDatabase } from "@/lib/users";
import type { SettingSource } from "@/lib/settings/types";

export interface ResolveOptions {
  /** The client whose preference should win for a client-scoped setting. */
  clientId?: string;
}

export class UnknownSettingError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Unknown setting "${key}".`);
    this.name = "UnknownSettingError";
    this.key = key;
  }
}

/**
 * Resolve the effective value of `key`, plus where it came from. Throws
 * UnknownSettingError for a key with no definition (unknown keys are never
 * silently null).
 */
export async function resolveSetting(
  db: AppDatabase,
  key: string,
  opts: ResolveOptions = {},
): Promise<{ value: unknown; source: SettingSource }> {
  const def = getDefinition(key);
  if (!def) throw new UnknownSettingError(key);

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
