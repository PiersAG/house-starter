// The signed-in caller, for a route limit's per-account count
// (lib/abuse/route-limit.ts, app-business-core #787).
//
// Keyed on the SESSION COOKIE, hashed — not on a second decode of the session.
// The route still decodes the session itself, once, exactly as before; the limit
// only needs a stable key for "this signed-in caller", and the cookie is one. It
// costs one SHA-256, no database read and no extra sign-in check, and the raw
// cookie never reaches the store (only its hash is a key there).
//
// A caller could hold several sessions, each counted on its own; minting them is
// itself limited (sign-in is limited per client and per account,
// lib/auth-rate-limit.ts), so this cannot be used to multiply the budget cheaply.
// The price plan is not in the cookie; a route with the subscription loaded
// passes its plan itself (planTierFor, config/rate-limits.ts), and BILL.07
// (app-business-core #379) carries the tier when tiers exist.

import "server-only";

import type { PlanTier } from "@/config/rate-limits";

/** The session cookie names Auth.js uses (secure prefix on https). */
export const SESSION_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** "s:<hash of the session cookie>", or null when the request carries no session. */
export async function sessionAccount(request: Request): Promise<{ id: string; plan?: PlanTier } | null> {
  const header = request.headers.get("cookie");
  // Auth.js splits a large token into .0, .1 … chunks; the first chunk is unique enough.
  const value = SESSION_COOKIES.map((n) => cookieValue(header, n) ?? cookieValue(header, `${n}.0`)).find(Boolean);
  if (!value) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return { id: `s:${hex}` };
}
