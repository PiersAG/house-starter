// Auth throttling — ONE path for every surface that authenticates.
//
// THE DEFECT THIS CLOSES
// ----------------------
// Rate limiting was well built (lib/rate-limit.ts) but wired only to the JSON
// API routes. The surfaces the UI actually posts to — the login, signup and
// reset-password SERVER ACTIONS — had none at all. So the limit existed on the
// door nobody uses and was absent from the door everyone uses, attackers
// included.
//
// The remedy is not "copy the limiter into three more files": two copies of a
// limit drift, and two SEPARATE limits let an attacker spend both budgets by
// alternating surfaces. Everything goes through this module, and a surface and
// its API twin share ONE bucket — `signup:1.2.3.4` is the same counter whether
// the attempt arrived as a server action or as JSON.
//
// WHERE THE GUARDS SIT
// --------------------
// At the SHARED path, never at the outermost handler, wherever the two differ:
//
//   login  — inside lib/auth.ts::authorize, not in app/login/actions.ts. The
//            NextAuth credentials endpoint (/api/auth/callback/credentials) is
//            publicly reachable; a guard that only sat in the server action
//            would be bypassed by posting straight at it, which is a fake fix.
//            The action maps the refusal to a friendly message (see
//            isAuthRateLimitError below).
//   signup — both entry points, plus a SECOND, much tighter bucket in front of
//            tenant provisioning. Each accepted signup calls
//            ensureTenantForUser, which creates a REAL hosted database: that is
//            a cost-and-quota attack, and a request-shaped limit is the wrong
//            shape for it.
//
// NOTE ON THE STORE: this module chooses WHERE limits are enforced, never what
// backs them. Today a deployed instance can still be running the in-memory
// stand-in, which resets constantly on serverless hosting — so these limits do
// not yet hold across instances. That is a separate fix
// (k9coach-rate-limit-store-production); the two want to land close together.

import { headers } from "next/headers";
import {
  clientKeyFromHeaders,
  getRateLimiter,
  type HeadersLike,
  type RateLimitOptions,
  type RateLimitResult,
} from "@/lib/rate-limit";

/** A limit plus the bucket it counts into. */
export type AuthRateLimit = RateLimitOptions & { bucket: string };

/**
 * Every auth limit in one place, so a reviewer can read the app's whole posture
 * without opening five files.
 *
 * The VALUES are the lever each app tunes; the EXISTENCE of the limits is
 * required by the quality baseline. Notes on the two that are not 5/60s:
 *
 *   login            10/60s — higher than signup because a real person
 *                    mistyping a password, plus an app's own E2E suite, will
 *                    exceed 5 in a minute; 10 still defeats credential
 *                    stuffing, which needs thousands.
 *   signup:provision 3/hour — this one is not request-shaped. It is the ceiling
 *                    on how many DATABASES a single client can cause to exist,
 *                    and databases are billed, quota'd and slow to reclaim.
 */
export const AUTH_RATE_LIMITS = {
  login: { bucket: "login", limit: 10, windowSeconds: 60 },
  signup: { bucket: "signup", limit: 5, windowSeconds: 60 },
  signupProvision: {
    bucket: "signup:provision",
    limit: 3,
    windowSeconds: 3600,
  },
  forgotPassword: { bucket: "forgot-password", limit: 5, windowSeconds: 60 },
  resetPassword: { bucket: "reset-password", limit: 5, windowSeconds: 60 },
} as const satisfies Record<string, AuthRateLimit>;

/**
 * Record one attempt against `config`'s bucket, keyed by client.
 *
 * Takes the headers rather than reading them, so a route handler (which holds a
 * Request) and a server action (which calls next/headers) reach the identical
 * counter by the identical key.
 */
export async function checkAuthRateLimit(
  config: AuthRateLimit,
  requestHeaders: HeadersLike,
): Promise<RateLimitResult> {
  const { bucket, ...options } = config;
  return getRateLimiter().hit(
    `${bucket}:${clientKeyFromHeaders(requestHeaders)}`,
    options,
  );
}

/**
 * The server-action / NextAuth-callback flavour: same counter, headers taken
 * from the ambient request. `next/headers` is available in both contexts.
 */
export async function guardAuthAttempt(
  config: AuthRateLimit,
): Promise<RateLimitResult> {
  return checkAuthRateLimit(config, await headers());
}

/**
 * Marker carried by a refusal thrown from inside NextAuth's `authorize`.
 *
 * NextAuth wraps anything thrown there in its own AuthError, and the login
 * action must tell "too many attempts" apart from "wrong password" — telling a
 * throttled user their password is wrong sends them to the reset flow, which
 * makes the problem worse. Matching on a marker string rather than on the class
 * is deliberate: the error crosses a framework boundary that may re-wrap or
 * serialise it, and the marker survives that.
 */
export const AUTH_RATE_LIMIT_MARKER = "auth_rate_limited";

/** Thrown when an auth attempt is refused inside a shared path. */
export class AuthRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(AUTH_RATE_LIMIT_MARKER);
    this.name = "AuthRateLimitError";
  }
}

/**
 * True when `error`, or anything in its `cause` chain, is a throttle refusal.
 * Walks the chain because NextAuth nests the original error two levels down
 * (CallbackRouteError -> { err }), and bounds the walk so a cyclic cause cannot
 * hang a request.
 */
export function isAuthRateLimitError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof AuthRateLimitError) return true;
    if (
      current instanceof Error &&
      current.message.includes(AUTH_RATE_LIMIT_MARKER)
    ) {
      return true;
    }
    const cause: unknown = current instanceof Error ? current.cause : undefined;
    // NextAuth's CallbackRouteError carries { err, provider } as its cause.
    current =
      cause && typeof cause === "object" && "err" in cause
        ? (cause as { err: unknown }).err
        : cause;
  }
  return false;
}
