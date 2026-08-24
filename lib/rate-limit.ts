// Rate limiting for the house-starter template.
//
// SHIPPED DEFAULT: a SHARED-STORE adapter. The store is selected from the
// environment so the deployed application enforces a limit that holds across
// every serverless instance and restart — an in-memory counter does not, on
// Vercel-style hosting it resets constantly and only looks like protection.
//
// Selection rules (see quality baseline items 4 and 11):
//   1. RATE_LIMIT_STORE_URL set  -> shared store (Upstash-compatible Redis REST).
//      This is the production / shipped default.
//   2. Otherwise, RATE_LIMIT_ALLOW_IN_MEMORY="true" (the explicit
//      safe-environment flag) -> in-memory stand-in. ONLY for the safe/test
//      build environment where nothing real is reachable (ADR-015) — and now
//      ONLY where VERCEL_ENV is unset. See below.
//   3. Neither set -> FAIL LOUDLY at startup, naming the missing variable.
//      We never silently fall back to in-memory as a default.
//
// THE HOLE THIS CLOSES. Rule 2 was written for "the safe/test build
// environment", and this file's own header said so — but nothing enforced it.
// safe-env-deploy.yml injects RATE_LIMIT_ALLOW_IN_MEMORY=true into every
// preview, and a safe-env preview is the surface real users reach (production
// promotion is a manual CEO step that does not exist yet). So the deployed app
// was running its rate limits on a per-instance counter that resets on every
// cold start — which on serverless hosting is not a slow limit, it is
// effectively no limit, while reading in the code as protection.
//
// The escape hatch is now keyed on VERCEL_ENV, the same signal
// lib/tenant/provisioner.ts::selectProvisionerName already treats as THE test
// for "this is a deployed environment". Deployed and no shared store = refuse to
// serve. That is deliberately fail-CLOSED and it applies to previews too,
// because the preview IS the live app (CEO decision, 2026-08-24). Local dev, CI
// and the isolation harness set no VERCEL_ENV and are unaffected.
//
// This module is pure logic with injectable dependencies (clock, fetch) so it
// is unit-tested directly. Nothing here runs at module load time.

export interface RateLimitOptions {
  /** Maximum number of requests permitted within the window. */
  limit: number;
  /** Length of the fixed window, in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  /** True when the request is under the limit and may proceed. */
  allowed: boolean;
  /** Requests remaining in the current window (never negative). */
  remaining: number;
  /** Seconds until the window resets — surfaced as the Retry-After header. */
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  /** Record one hit against `key` and report whether it is allowed. */
  hit(key: string, options: RateLimitOptions): Promise<RateLimitResult>;
}

/**
 * In-memory fixed-window counter. SAFE-ENVIRONMENT STAND-IN ONLY — it is never
 * shipped as the default (see selection rules above). A clock is injected so
 * window expiry is deterministic in tests.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async hit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    const nowMs = this.now();
    const windowMs = options.windowSeconds * 1000;
    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= nowMs) {
      const resetAt = nowMs + windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        remaining: options.limit - 1,
        retryAfterSeconds: options.windowSeconds,
      };
    }

    existing.count += 1;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((existing.resetAt - nowMs) / 1000),
    );
    const allowed = existing.count <= options.limit;
    return {
      allowed,
      remaining: Math.max(0, options.limit - existing.count),
      retryAfterSeconds,
    };
  }
}

/** Minimal subset of the global `fetch` signature this module relies on. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Shared-store adapter backed by an Upstash-compatible Redis REST endpoint.
 * This is the shipped default. A fixed-window counter is implemented with
 * INCR (+ EXPIRE on first hit) and TTL for the retry hint. `fetch` is injected
 * so the adapter is unit-testable without a live Redis.
 */
export class RedisRestRateLimitStore implements RateLimitStore {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
  ) {
    // Trim a trailing slash so command paths join cleanly.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async command(...args: (string | number)[]): Promise<unknown> {
    const path = args.map((a) => encodeURIComponent(String(a))).join("/");
    const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Rate-limit store command failed (${res.status}) for "${args[0]}".`,
      );
    }
    const body = (await res.json()) as { result?: unknown };
    return body.result;
  }

  async hit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    const count = Number(await this.command("incr", key));
    if (count === 1) {
      await this.command("expire", key, options.windowSeconds);
    }
    let retryAfterSeconds = options.windowSeconds;
    const ttl = Number(await this.command("ttl", key));
    if (Number.isFinite(ttl) && ttl > 0) {
      retryAfterSeconds = ttl;
    }
    return {
      allowed: count <= options.limit,
      remaining: Math.max(0, options.limit - count),
      retryAfterSeconds,
    };
  }
}

/** Environment shape this module reads. Injected in tests for determinism. */
export type RateLimitEnv = {
  RATE_LIMIT_STORE_URL?: string;
  RATE_LIMIT_STORE_TOKEN?: string;
  RATE_LIMIT_ALLOW_IN_MEMORY?: string;
  /**
   * Set by the platform on every deployed instance ("production" | "preview" |
   * "development"). Its PRESENCE, not its value, is the signal: any value means
   * a deployed instance, which may not run on the in-memory stand-in. Absent
   * locally, in CI, and in the isolation harness.
   */
  VERCEL_ENV?: string;
};

/**
 * Build the rate-limit store for the current environment, applying the
 * selection rules. Throws loudly when neither a shared store nor the explicit
 * safe-environment flag is configured — refusing to start is safer than
 * running with an in-memory counter that only looks like protection.
 */
export function createRateLimitStore(
  env: RateLimitEnv = process.env as RateLimitEnv,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): RateLimitStore {
  const url = env.RATE_LIMIT_STORE_URL?.trim();
  if (url) {
    const token = env.RATE_LIMIT_STORE_TOKEN?.trim();
    if (!token) {
      throw new Error(
        "RATE_LIMIT_STORE_URL is set but RATE_LIMIT_STORE_TOKEN is missing. " +
          "The shared rate-limit store requires both.",
      );
    }
    return new RedisRestRateLimitStore(url, token, fetchImpl);
  }

  const deployed = (env.VERCEL_ENV ?? "").trim().length > 0;

  if (env.RATE_LIMIT_ALLOW_IN_MEMORY === "true") {
    if (deployed) {
      // The stand-in is refused HERE, not merely discouraged in a comment. A
      // deployed instance that fell back to it would report rate limiting as
      // working while enforcing nothing across instances.
      throw new Error(
        "RATE_LIMIT_STORE_URL is not set, and RATE_LIMIT_ALLOW_IN_MEMORY=true " +
          `cannot be honoured on a deployed instance (VERCEL_ENV=${env.VERCEL_ENV}). ` +
          "The in-memory counter is per-instance and resets on every cold " +
          "start, so on serverless hosting it is not a slower limit — it is no " +
          "limit. Set RATE_LIMIT_STORE_URL and RATE_LIMIT_STORE_TOKEN to a " +
          "shared store (an Upstash-compatible Redis REST endpoint). Refusing " +
          "to serve with rate limiting that does not hold.",
      );
    }
    return new InMemoryRateLimitStore();
  }

  throw new Error(
    "Rate limiting is not configured. Set RATE_LIMIT_STORE_URL (and " +
      "RATE_LIMIT_STORE_TOKEN) to a shared store such as Upstash Redis. " +
      "Only the safe test environment may set RATE_LIMIT_ALLOW_IN_MEMORY=true " +
      "to use the in-memory stand-in. Refusing to start with no rate limiting.",
  );
}

// Process-wide singleton so every route bundle shares one store (and, for the
// in-memory stand-in, one set of counters). Built lazily on first use so the
// loud failure surfaces at request time, never at module-load/build time.
let cachedStore: RateLimitStore | undefined;

/** Return the shared rate-limit store, constructing it once on first call. */
export function getRateLimiter(): RateLimitStore {
  if (!cachedStore) {
    cachedStore = createRateLimitStore();
  }
  return cachedStore;
}

/** Test-only hook to reset the cached singleton. */
export function resetRateLimiterForTests(): void {
  cachedStore = undefined;
}

/**
 * The subset of `Headers` a client key is derived from. Widened from `Headers`
 * so a server action can pass what `next/headers` returns (a ReadonlyHeaders,
 * which omits the mutators) without a cast — same function, same key, both
 * surfaces (lib/auth-rate-limit.ts).
 */
export type HeadersLike = { get(name: string): string | null };

/**
 * Derive a best-effort client identifier from request headers.
 *
 * ORDER MATTERS, AND IT CHANGED (finding 6). This used to take the LEFT-MOST
 * `x-forwarded-for` entry. That entry is whatever the CLIENT sent: a proxy that
 * APPENDS (rather than overwrites) leaves an attacker-chosen value sitting in
 * front of the real one, so every request could carry a fresh "IP" and spend a
 * fresh budget — a rate limiter keyed on a value the rate-limited party picks is
 * not a rate limiter. Vercel normalises the header today, which is why this was
 * not exploitable there; it is wrong on any host that does not, and the app is
 * not entitled to assume its host.
 *
 * So: `x-real-ip` first (single-valued, set by the proxy, not forwarded from the
 * client), then the RIGHT-MOST `x-forwarded-for` entry — the hop appended by the
 * closest trusted proxy, and the only entry a caller further out cannot forge.
 *
 * Both surfaces get the SAME key: the widened `HeadersLike` parameter means the
 * JSON routes (a real `Headers`) and the server actions (ReadonlyHeaders from
 * `next/headers`, lib/auth-rate-limit.ts) share one derivation, so an attacker
 * cannot spend a separate budget by switching surface.
 */
export function clientKeyFromHeaders(headers: HeadersLike): string {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const nearest = hops[hops.length - 1];
    if (nearest) return nearest;
  }
  return "unknown";
}
