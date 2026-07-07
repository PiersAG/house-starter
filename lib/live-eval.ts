/**
 * live-eval.ts — LIVE-EVAL evaluator allowlist enforcement (ADR-026 D4).
 *
 * Reads three env vars at request time and answers whether a given
 * authenticated email is permitted access under the app's current lifecycle
 * state:
 *
 *   APP_LIFECYCLE_STATE   — LAUNCHED | LIVE_EVAL | LIVE_OPEN.
 *                           Absent or unknown values are treated as LIVE_EVAL
 *                           by design: the safer fallback is to require an
 *                           allowlist match, not to open the app up.
 *   EVALUATOR_ALLOWLIST   — comma-separated emails (case-insensitive, trimmed).
 *   CEO_EMAIL             — the CEO's email; ALWAYS treated as permitted
 *                           regardless of the allowlist. The CEO must never be
 *                           locked out of his own portfolio by a gate meant
 *                           for strangers (ADR-026 D4).
 *
 * Fail-closed semantics: LIVE_EVAL with an empty allowlist AND no CEO_EMAIL
 * set means no-one but a matching allowlist entry can pass — and since the
 * allowlist is empty and there is no CEO email either, nothing matches. That
 * is deliberate: an app in LIVE_EVAL with no evaluators is not usable, and
 * the middleware should refuse rather than silently open.
 *
 * Server-side only: this file is imported from middleware.ts and other
 * server code. Do NOT import from client code — the values must never reach
 * a NEXT_PUBLIC_ variable (ADR-026 D4 explicit).
 */

export type LifecycleState = "LAUNCHED" | "LIVE_EVAL" | "LIVE_OPEN";

const KNOWN_STATES: readonly LifecycleState[] = ["LAUNCHED", "LIVE_EVAL", "LIVE_OPEN"] as const;

export function currentLifecycleState(): LifecycleState {
  const raw = (process.env.APP_LIFECYCLE_STATE ?? "").toUpperCase();
  return (KNOWN_STATES as readonly string[]).includes(raw)
    ? (raw as LifecycleState)
    : "LIVE_EVAL"; // safer default: never open to the public without explicit setting
}

function normalise(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** The effective allowlist: env EVALUATOR_ALLOWLIST plus CEO_EMAIL if set. */
export function effectiveAllowlist(): string[] {
  const raw = process.env.EVALUATOR_ALLOWLIST ?? "";
  const list = raw
    .split(",")
    .map((s) => normalise(s))
    .filter((s) => s.length > 0);
  const ceo = normalise(process.env.CEO_EMAIL);
  if (ceo && !list.includes(ceo)) list.push(ceo);
  return list;
}

export type AccessDecision =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * Decide whether an authenticated email is allowed access under the current
 * lifecycle state. NOTE: this function assumes the caller has already ensured
 * the request is authenticated (the middleware's existing NextAuth check).
 * A null / empty email is treated as unauthenticated for the purposes of this
 * check and the caller should reject it upstream.
 */
export function decideAccess(email: string | null | undefined): AccessDecision {
  const state = currentLifecycleState();
  const e = normalise(email);

  if (state === "LIVE_OPEN") {
    // No allowlist filter after public launch — the DP gate (ADR-026 D3) is
    // what protects the public here, not the middleware.
    return { allow: true };
  }

  if (!e) {
    return { allow: false, reason: "no-authenticated-email" };
  }

  const allowlist = effectiveAllowlist();

  if (state === "LAUNCHED") {
    // Live-quiet: any authenticated user passes (the launcher's tier is
    // pre-evaluator, so no filter). This branch exists so the middleware
    // can treat "no APP_LIFECYCLE_STATE" as LIVE_EVAL safely without
    // accidentally locking down a live-quiet-only app that never opted in.
    return { allow: true };
  }

  // LIVE_EVAL — fail-closed on an empty allowlist.
  if (allowlist.length === 0) {
    return {
      allow: false,
      reason: "live-eval-empty-allowlist",
    };
  }

  if (allowlist.includes(e)) {
    return { allow: true };
  }
  return { allow: false, reason: "not-on-evaluator-allowlist" };
}
