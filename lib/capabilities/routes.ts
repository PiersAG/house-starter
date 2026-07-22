// Capability route registry + path matcher (capability-model-spec R2 · routes,
// steps 7–9). Client/edge-safe: imports only the config-only flags predicate —
// no next/server, no db, no settings registry — so it bundles into edge
// middleware and the client without pulling anything heavy in.
//
// WHY THIS EXISTS. R2 requires that when a capability is OFF, every route/API
// belonging to it is INERT — it answers 404, as though it does not exist (never
// merely UI-hidden). Steps 3–4 closed the settings-key and nav surfaces; this
// closes the capability's OWN feature routes. None of payments/booking/comms has
// real routes yet, so this is the ENFORCEMENT SCAFFOLDING each feature attaches
// to when built: it declares the route prefixes each capability WILL own and
// makes any request under an OFF capability's prefix 404 today — current paths
// and not-yet-built ones alike. The both-states matrix asserts this as a REAL
// 404 (was the documented empty-registry placeholder from step 2).
//
// When a feature is built it (a) creates its routes under its registered prefix
// — already gated here — and SHOULD also call requireCapability() in its own
// handler as defence in depth (lib/capabilities/guard.ts), and (b) flips its
// flag on in config/capabilities.ts. Nothing else needs wiring.

import { isCapabilityEnabled } from "@/lib/capabilities/flags";
import type { CapabilityFlag } from "@/config/capabilities";

/**
 * Route/API prefixes each capability owns. A prefix gates itself and everything
 * beneath it (segment-boundary — `/api/payments` covers `/api/payments/x`, not
 * `/api/paymentsX`). These are the surfaces each capability WILL expose; they do
 * not exist as handlers yet, which is the point — the gate makes them absent
 * until the feature is built AND turned on. Keep in sync with CAPABILITY_NAV
 * (lib/nav/primary-nav.ts): a capability's dashboard page prefix appears in both.
 *
 * NOTE — placeholder destinations. Until a capability is built, its prefixes
 * have no handler; with the flag OFF (the default) they 404 via this gate, and
 * with the flag ON they would 404 via Next's own routing. Turning a capability
 * ON is only valid once its feature exists.
 */
export const CAPABILITY_ROUTES: Record<CapabilityFlag, string[]> = {
  // CLIENT PAYMENTS (client-pay checkout, payment requests, payments-due board).
  // NOT owner→factory subscription billing (that is KERNEL, always on).
  payments: ["/api/payments", "/dashboard/payments"],
  // Interactive self-serve booking.
  booking: ["/api/bookings", "/dashboard/bookings"],
  // Client messaging / comms.
  comms: ["/api/messages", "/dashboard/messages"],
};

/** True when `path` is exactly `prefix` or sits beneath it on a segment
 * boundary, so `/api/payments` never matches `/api/paymentsX`. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * The capability that owns `pathname`, or null when it belongs to no capability
 * (core/kernel routes — always on). Prefixes are disjoint by construction, so
 * the first match is the owner.
 */
export function capabilityForPath(pathname: string): CapabilityFlag | null {
  for (const flag of Object.keys(CAPABILITY_ROUTES) as CapabilityFlag[]) {
    if (CAPABILITY_ROUTES[flag].some((prefix) => underPrefix(pathname, prefix))) {
      return flag;
    }
  }
  return null;
}

/**
 * True when `pathname` belongs to a capability that is currently OFF — i.e. the
 * request must be answered 404 (the surface is absent). A core/kernel path, or a
 * path whose capability is on, returns false. This is the single predicate both
 * the edge middleware (runtime enforcement) and requireCapabilityForPath
 * (per-handler defence + the matrix assertion) resolve through.
 */
export function isPathDisabledByCapability(pathname: string): boolean {
  const flag = capabilityForPath(pathname);
  return flag !== null && !isCapabilityEnabled(flag);
}
