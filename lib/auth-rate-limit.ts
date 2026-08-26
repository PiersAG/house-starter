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
 * The provisioning ceiling that applies in the SAFE TEST ENVIRONMENT only.
 *
 * WHY THIS EXISTS. `clientKeyFromHeaders` derives the key from `x-real-ip` /
 * `x-forwarded-for`. A local run has neither — no proxy sets them — so every
 * request keys to the literal string "unknown" and the whole suite shares ONE
 * bucket. That is the limiter behaving correctly (an e2e suite genuinely IS one
 * client), but it means any suite that signs up more than three times fails on
 * the fourth: house-starter's own template suite, and every app's, drive sign-up
 * repeatedly to reach an authenticated page. k9coach-v2's core-ui suite signs up
 * four times and hit exactly this.
 *
 * WHY RAISING IT HERE IS SAFE — the resource the 3/hour limit protects does not
 * exist in this environment. That limit is not request-shaped: it is the ceiling
 * on how many REAL hosted databases one client can cause to be created, because
 * those are billed, quota'd and slow to reclaim (see AUTH_RATE_LIMITS below).
 * With no VERCEL_ENV, lib/tenant/provisioner.ts selects the FILE adapter, so a
 * "provisioned database" is a throwaway file under .build/tenants. There is
 * nothing billed to protect.
 *
 * Still a real limit, not a bypass: the guard runs, the store is hit, the same
 * code path is exercised — only the number differs. 100/hour is far above any
 * plausible suite and far below anything that could exhaust a runner's disk.
 */
const SAFE_TEST_PROVISION_LIMIT = 100;

/**
 * The only two variables this module reads from the environment. Narrow and
 * injectable for the same reason lib/rate-limit.ts's RateLimitEnv is: the
 * both-states tests below pin the deployed case by passing an env, and a test
 * must not have to fabricate a whole ProcessEnv to do it.
 */
export type AuthRateLimitEnv = {
  RATE_LIMIT_ALLOW_IN_MEMORY?: string;
  /**
   * Set by the platform on every deployed instance. Its PRESENCE, not its
   * value, is the signal — same treatment as lib/rate-limit.ts.
   */
  VERCEL_ENV?: string;
};

/**
 * True only in ADR-015's safe/test build environment, where nothing real is
 * reachable.
 *
 * Deliberately the SAME two-part signal lib/rate-limit.ts already uses to decide
 * whether the in-memory stand-in may be used: the explicit
 * RATE_LIMIT_ALLOW_IN_MEMORY opt-in AND the absence of VERCEL_ENV. Both halves
 * are required, and a DEPLOYED instance can satisfy neither path to this
 * relaxation: VERCEL_ENV is set on every deployed instance (preview and
 * production alike), and lib/rate-limit.ts already REFUSES TO SERVE there when
 * ALLOW_IN_MEMORY is set. Re-deriving `deployed` here instead of trusting that
 * refusal is on purpose — this exemption stands on its own check rather than on
 * another module's control flow continuing to behave as it does today.
 */
export function inSafeTestEnvironment(
  env: AuthRateLimitEnv = process.env as AuthRateLimitEnv,
): boolean {
  const deployed = (env.VERCEL_ENV ?? "").trim().length > 0;
  return !deployed && env.RATE_LIMIT_ALLOW_IN_MEMORY === "true";
}

/**
 * The limit actually enforced for `config` in the current environment.
 *
 * The identity function everywhere that matters: only `signup:provision`, and
 * only in the safe test environment, resolves to anything other than the
 * declared config. Exported so the both-states behaviour is unit-testable
 * without booting the app.
 */
export function effectiveAuthRateLimit(
  config: AuthRateLimit,
  env: AuthRateLimitEnv = process.env as AuthRateLimitEnv,
): AuthRateLimit {
  if (config.bucket !== AUTH_RATE_LIMITS.signupProvision.bucket) return config;
  if (!inSafeTestEnvironment(env)) return config;
  return { ...config, limit: SAFE_TEST_PROVISION_LIMIT };
}

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
  const { bucket, ...options } = effectiveAuthRateLimit(config);
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
