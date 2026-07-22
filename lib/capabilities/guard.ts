// Capability substrate — server-only enforcement half (capability-model-spec R2).
//
// The sanctioned way a route handler or API handler makes an OFF capability
// INERT: it answers 404, as though the surface does not exist. Route handlers
// import from here; the client-safe predicate (isCapabilityEnabled) lives in
// ./flags.ts so nav/components never pull next/server into the client bundle.
//
// Why 404 and not 403: a disabled capability must look ABSENT, not forbidden.
// An endpoint that answers 401/403 has confirmed it exists — that is "on". R2's
// bar is that the route does not answer at all for a caller of an off capability.

import { NextResponse } from "next/server";
import { isCapabilityEnabled } from "@/lib/capabilities/flags";
import { flagForSettingKey } from "@/lib/capabilities/settings";
import { capabilityForPath } from "@/lib/capabilities/routes";

/** The 404 a guarded surface returns when its capability is off. */
export function capabilityNotFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

/**
 * Route/API guard. Returns a 404 Response when `flag` is off, or `null` when the
 * caller may proceed. Usage at the top of a handler:
 *
 *   const denied = requireCapability(flag);
 *   if (denied) return denied;
 *
 * A null/undefined flag (core, or a kernel flag which is always on) returns null.
 */
export function requireCapability(
  flag: string | null | undefined,
): NextResponse | null {
  return isCapabilityEnabled(flag) ? null : capabilityNotFound();
}

/**
 * Settings-API guard: the 404 Response when `key` belongs to an OFF capability,
 * else null. This is what closes the R2 gap the audit named on the settings
 * write path — a write to e.g. `billing.currency` while `payments` is off must
 * 404, not merely be hidden in the Settings UI. An UNKNOWN key returns null here
 * (its flag resolves to null → enabled) and is left to the caller's existing
 * unknown-key handling (a 404 for a different, honest reason).
 */
export function requireCapabilityForSettingKey(key: string): NextResponse | null {
  return requireCapability(flagForSettingKey(key));
}

/**
 * Route/API guard by PATH: the 404 Response when `pathname` belongs to an OFF
 * capability (per CAPABILITY_ROUTES), else null. Two callers resolve through the
 * same path→flag map:
 *   • the edge middleware, which runs this on every request so a capability's
 *     whole route subtree is inert when off — current handlers and not-yet-built
 *     ones alike (the request-level 404 R2 requires);
 *   • a feature's own route handler, which SHOULD also call this at the top as
 *     defence in depth once the feature is built:
 *         const denied = requireCapabilityForPath(new URL(req.url).pathname);
 *         if (denied) return denied;
 * A core/kernel path (owned by no capability) returns null.
 */
export function requireCapabilityForPath(pathname: string): NextResponse | null {
  return requireCapability(capabilityForPath(pathname));
}
