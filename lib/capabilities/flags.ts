// Capability substrate — client-safe predicate half (capability-model-spec R2).
//
// This is the ONE import site for "is this capability on?" that runs anywhere:
// client components, nav rendering, server components. It is deliberately free
// of any server-only import (no next/server, no db, no registry) so it can be
// pulled into a client bundle. The server-only enforcement half — the thing
// that turns "off" into an HTTP 404 — lives in ./guard.ts.
//
// Flag resolution is delegated, not re-implemented: capability flags resolve
// through config/capabilities.ts, kernel flags through config/kernel.ts. Both
// are unified by isFlagEnabled (a kernel flag is always on in a real build).

import { isFlagEnabled } from "@/config/capabilities";

/**
 * True when the capability (or kernel) flag governing something is enabled.
 * Nav and components use this to decide whether to SHOW a capability's UI —
 * additive polish on top of the route/API 404, never a substitute for it (R2):
 * hiding a link does not stop a hand-typed request, the 404 in ./guard.ts does.
 *
 * A null/undefined flag means "core" (no flag) → always enabled.
 */
export function isCapabilityEnabled(flag: string | null | undefined): boolean {
  return isFlagEnabled(flag);
}
