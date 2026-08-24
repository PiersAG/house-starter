// App display name — the one place the product's name is resolved for the
// browser-tab title (and available to any other surface that needs it).
//
// The name comes from the settings-registry value `core.app_name` (owner
// scope) WHERE THE OWNER HAS SET ONE, falling back to a neutral placeholder.
// It is deliberately NOT a hardcoded template brand ("House Starter"): the
// template ships neutral, and each app's real name is owner configuration, not
// a code string.
//
// Resolution is resilient by design — this runs in the root layout's
// generateMetadata, on every request including anonymous/error paths, so it
// must never throw. Any failure (settings capability off, catalog unavailable,
// or simply no value set) resolves to the neutral fallback.
//
// It reads the CATALOG ONLY — no tenant database is passed, and that is
// deliberate twice over. Mechanically: this runs on the login page and the
// marketing pages where there is no session and therefore no tenant, so a
// per-tenant app whose title depended on tenant data would be titleless to every
// visitor who had not signed in yet. Structurally: `core.app_name` is an
// OPERATOR key (operatorOnly, see lib/settings/core.settings.ts). One app is one
// brand. The resolver skips the tenant plane for such a key regardless, so this
// call site and that classification agree rather than merely coexist.

import { catalogDb } from "@/lib/catalog";
import { resolveSetting } from "@/lib/settings/resolver";

/**
 * Neutral fallback used when no app name is configured. Deliberately generic —
 * not the template brand and not any specific app's name.
 */
export const APP_NAME_FALLBACK = "App";

/**
 * The effective app display name: the operator-set `core.app_name` if present
 * and non-empty, otherwise {@link APP_NAME_FALLBACK}. Never throws.
 */
export async function getAppName(): Promise<string> {
  try {
    const { value } = await resolveSetting({ catalog: catalogDb }, "core.app_name");
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  } catch {
    // Settings unreadable here (capability off, no DB, per-tenant mode, …) —
    // fall through to the neutral fallback rather than failing the render.
  }
  return APP_NAME_FALLBACK;
}
