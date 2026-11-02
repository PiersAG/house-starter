// Route limits, probing and escalation (PiersAG/app-business-core#787, #748).
//
// Every route handler and server action passes through checkRouteLimit with the
// id of its group in config/rate-limits.ts. One call does, in order:
//
//   1. BAN       a client the escalation banned is refused until the ban ends.
//   2. ATTACK    the edge rule set (config/edge-firewall.ts) runs here too, so an
//                SQL-injection or path-traversal payload to an API route is
//                refused (403) and scored even with no edge firewall in front.
//   3. PROBE     the same endpoint hit more than 50 times in one second by one
//                client or one account is probing (Matt Murphy #170): refused
//                and scored heavily.
//   4. HARD      the group's fixed window, per client and per account (layer 1),
//                scaled by the account's price plan (layer 3) and by the system's
//                health (layer 2), and cut to a quarter while the client is
//                throttled. Over it: 429 with Retry-After.
//
// ESCALATION (Matt Murphy #12): each refusal scores strikes against the client,
// weighted by what it did (config/rate-limits.ts ESCALATION). Past `throttleAt`
// the client's limits are cut; past `banAt` it is banned for `banSeconds`. A
// refused sign-in scores too (recordBehaviour, from the login action), so a
// client guessing passwords slowly under every limit is still banned in time.
//
// STORE OUTAGE: the counters live in the shared store (lib/rate-limit.ts). If
// the store is CONFIGURED but a call to it fails at run time, an ordinary route
// is served and the failure logged — a store blip must not take every page of
// the app down, which would hand an attacker the outage they were after. A
// route group marked `failClosed` (sign-in, sign-up, password reset, the second
// sign-in step) is REFUSED instead, with a 503 (ADR-015: the sign-in surfaces
// fail closed). Those routes also keep their own per-attempt limits
// (lib/auth-rate-limit.ts), which throw on a store error; this makes the outer
// budget agree with them rather than relying on the inner one alone. A store
// that is NOT configured still refuses to start (createRateLimitStore).
//
// Events go to the security log (lib/security-log.ts) with the client address,
// which the DDoS playbook (app-business-core wiki/policies/ddos-playbook.md)
// reads to decide what to block at the edge.

import "server-only";

import { headers as requestHeaders } from "next/headers";
import {
  ESCALATION,
  HEALTH_ADAPTIVE,
  PLAN_MULTIPLIERS,
  PROBE,
  ROUTE_LIMITS,
  type Behaviour,
  type PlanTier,
  type RouteLimit,
  type RouteLimitId,
  type Window,
} from "@/config/rate-limits";
import { matchEdgeRule } from "@/config/edge-firewall";
import { clientKeyFromHeaders, getRateLimiter, windowKey, type CounterStore, type HeadersLike } from "@/lib/rate-limit";
import { logSecurityEvent, type SecurityEvent, type SecurityFieldValue } from "@/lib/security-log";
import { errorCountSince } from "@/lib/observability/error-log";
import { inSafeTestEnvironment } from "@/lib/auth-rate-limit";

/**
 * In the SAFE TEST ENVIRONMENT only (no VERCEL_ENV, and the explicit in-memory
 * opt-in — the same two-part test the sign-in limits use), every limit and every
 * escalation threshold is ten times higher. An end-to-end suite is ONE client
 * (every request keys to the same address), and its deliberate wrong-password
 * tests would otherwise ban it part-way through. Still a real limit, not a
 * bypass: the same code runs and attack payloads are refused exactly as
 * deployed. A deployed instance can never be in this environment.
 */
export const SAFE_TEST_FACTOR = 10;

export type RouteLimitRefusal = {
  allowed: false;
  reason: "banned" | "attack" | "probe" | "limit" | "unavailable";
  status: 403 | 429 | 503;
  retryAfterSeconds: number;
};
export type RouteLimitDecision = { allowed: true } | RouteLimitRefusal;

export type RouteLimitInput = {
  route: RouteLimitId;
  headers: HeadersLike;
  /** The request URL (path and query), checked against the edge rule set. */
  url?: string;
  /** The signed-in account, where the route knows it. */
  accountId?: string | null;
  /** The account's price plan; signed out = "none". */
  plan?: PlanTier;
};

export type RouteLimitDeps = {
  store?: CounterStore;
  now?: () => number;
  /** The health multiplier, 0 < f <= 1. Defaults to the cached error-rate reading. */
  healthFactor?: () => Promise<number>;
  log?: (event: SecurityEvent, fields: Record<string, SecurityFieldValue>) => void;
  /** Defaults to inSafeTestEnvironment(); tests pin it. */
  safeTestEnvironment?: boolean;
};

const relaxOf = (deps: RouteLimitDeps) =>
  (deps.safeTestEnvironment ?? inSafeTestEnvironment()) ? SAFE_TEST_FACTOR : 1;

const BAN = (client: string) => `abuse:ban:${client}`;
const STRIKES = (client: string) => `abuse:strikes:${client}`;

/** A window's limit after the plan, health and throttle multipliers; never below 1. */
export function effectiveLimit(
  window: Window,
  o: { publicRoute: boolean; plan: PlanTier; healthFactor: number; throttled: boolean },
): number {
  const plan = o.publicRoute ? 1 : PLAN_MULTIPLIERS[o.plan];
  const throttle = o.throttled ? ESCALATION.throttleFactor : 1;
  return Math.max(1, Math.floor(window.limit * plan * o.healthFactor * throttle));
}

// ── Layer 2: the system's health ───────────────────────────────────────────
let healthCache: { at: number; factor: number } | null = null;

/** Health multiplier from the recent server-error count, cached per instance. */
export async function healthFactorFromErrors(
  now: () => number = Date.now,
  count: (sinceMs: number) => Promise<number> = (since) => errorCountSince(since),
): Promise<number> {
  const t = now();
  if (healthCache && t - healthCache.at < HEALTH_ADAPTIVE.cacheSeconds * 1000) return healthCache.factor;
  let factor = 1;
  try {
    const n = await count(t - HEALTH_ADAPTIVE.windowSeconds * 1000);
    factor = n > HEALTH_ADAPTIVE.degradedErrors ? HEALTH_ADAPTIVE.degradedFactor : 1;
  } catch {
    factor = 1; // an unreadable error log is "unknown", not "degraded"
  }
  healthCache = { at: t, factor };
  return factor;
}

/** Test hook. */
export function resetRouteLimitForTests(): void {
  healthCache = null;
}

// ── Escalation ─────────────────────────────────────────────────────────────
async function strike(
  store: CounterStore,
  client: string,
  behaviour: Behaviour,
  nowMs: number,
  log: NonNullable<RouteLimitDeps["log"]>,
  relax: number,
): Promise<void> {
  const weight = ESCALATION.strikes[behaviour];
  const total = await store.add(STRIKES(client), weight, ESCALATION.strikeWindowSeconds);
  if (total >= ESCALATION.banAt * relax) {
    await store.holdUntil(BAN(client), Math.floor(nowMs / 1000) + ESCALATION.banSeconds);
    log("abuse_banned", { client, behaviour, strikes: total, banSeconds: ESCALATION.banSeconds });
  } else if (total >= ESCALATION.throttleAt * relax && total - weight < ESCALATION.throttleAt * relax) {
    log("abuse_throttled", { client, behaviour, strikes: total });
  }
}

/**
 * Score a behaviour the route itself observed (a refused sign-in, for one).
 * Never throws: scoring is best effort and must not fail the request.
 */
export async function recordBehaviour(
  headers: HeadersLike,
  behaviour: Behaviour,
  deps: RouteLimitDeps = {},
): Promise<void> {
  const log = deps.log ?? logSecurityEvent;
  try {
    const store = deps.store ?? getRateLimiter();
    await strike(store, clientKeyFromHeaders(headers), behaviour, (deps.now ?? Date.now)(), log, relaxOf(deps));
  } catch (e) {
    log("rate_limit_store_error", { where: "recordBehaviour", message: e instanceof Error ? e.message : "unknown" });
  }
}

function splitUrl(url: string): { path: string; query: string } {
  const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "") || "/";
  const i = rest.indexOf("?");
  return i === -1 ? { path: rest, query: "" } : { path: rest.slice(0, i), query: rest.slice(i + 1) };
}

/** The one check every route and server action makes. */
export async function checkRouteLimit(input: RouteLimitInput, deps: RouteLimitDeps = {}): Promise<RouteLimitDecision> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? logSecurityEvent;
  const config: RouteLimit = ROUTE_LIMITS[input.route];
  const client = clientKeyFromHeaders(input.headers);
  const nowMs = now();
  const relax = relaxOf(deps);
  // not configured: this throws, and the route refuses to serve (lib/rate-limit.ts)
  const store = deps.store ?? getRateLimiter();

  try {
    // 1. ban, and the strikes that decide a throttle (one read each, in parallel)
    const [bannedUntil, strikes] = await Promise.all([
      store.heldUntil(BAN(client)),
      store.add(STRIKES(client), 0, ESCALATION.strikeWindowSeconds),
    ]);
    if (bannedUntil > 0) {
      return { allowed: false, reason: "banned", status: 429, retryAfterSeconds: Math.max(1, bannedUntil - Math.floor(nowMs / 1000)) };
    }

    // 2. the edge rule set, inside the app
    if (input.url) {
      const rule = matchEdgeRule({ ...splitUrl(input.url), userAgent: input.headers.get("user-agent") ?? "" });
      if (rule) {
        log("attack_request_refused", { client, route: input.route, rule: rule.id });
        await strike(store, client, "attack_path", nowMs, log, relax);
        return { allowed: false, reason: "attack", status: 403, retryAfterSeconds: 0 };
      }
    }

    // 3 and 4. probe and hard-limit counters, in parallel
    const healthFactor = await (deps.healthFactor ?? (() => healthFactorFromErrors(now)))();
    const throttled = strikes >= ESCALATION.throttleAt * relax;
    const plan: PlanTier = input.accountId ? (input.plan ?? "none") : "none";
    const limits = { publicRoute: config.public, plan, healthFactor: healthFactor * relax, throttled };
    const probeLimit = PROBE.limit * relax;
    const account = input.accountId ? `a:${input.accountId}` : null;
    const perAccount: Window | undefined = "perAccount" in config ? config.perAccount : undefined;
    const [clientCount, accountCount, probeClient, probeAccount] = await Promise.all([
      store.add(`rl:${input.route}:c:${client}`, 1, config.perClient.windowSeconds),
      account && perAccount ? store.add(`rl:${input.route}:${account}`, 1, perAccount.windowSeconds) : Promise.resolve(0),
      store.add(`rl:${input.route}:probe:c:${client}`, 1, PROBE.windowSeconds),
      account ? store.add(`rl:${input.route}:probe:${account}`, 1, PROBE.windowSeconds) : Promise.resolve(0),
    ]);

    if (probeClient > probeLimit || probeAccount > probeLimit) {
      if (probeClient === probeLimit + 1 || probeAccount === probeLimit + 1) {
        log("route_rate_limited", { client, route: input.route, reason: "probe", accountId: input.accountId ?? null });
        await strike(store, client, "probe", nowMs, log, relax);
      }
      return { allowed: false, reason: "probe", status: 429, retryAfterSeconds: 1 };
    }

    const overClient = clientCount > effectiveLimit(config.perClient, limits);
    const overAccount = !!perAccount && accountCount > effectiveLimit(perAccount, limits);
    if (overClient || overAccount) {
      const w = overClient ? config.perClient : (perAccount as Window);
      const first = overClient
        ? clientCount === effectiveLimit(config.perClient, limits) + 1
        : accountCount === effectiveLimit(perAccount as Window, limits) + 1;
      if (first) {
        // one log line and one strike per client per window, not one per refused request
        log("route_rate_limited", { client, route: input.route, reason: "limit", accountId: input.accountId ?? null, throttled, healthFactor, plan });
        await strike(store, client, "limit_hit", nowMs, log, relax);
      }
      return { allowed: false, reason: "limit", status: 429, retryAfterSeconds: windowKey("", w.windowSeconds, nowMs).ttl };
    }
    return { allowed: true };
  } catch (e) {
    const failClosed = config.failClosed === true;
    log("rate_limit_store_error", {
      route: input.route,
      message: e instanceof Error ? e.message : "unknown",
      outcome: failClosed ? "refused" : "served",
    });
    // ADR-015: a sign-in surface never runs unlimited because the store failed.
    if (failClosed) return { allowed: false, reason: "unavailable", status: 503, retryAfterSeconds: 30 };
    return { allowed: true };
  }
}

/** The plain-English refusal, as a JSON answer with Retry-After. */
export function refusalResponse(d: RouteLimitRefusal): Response {
  const error =
    d.reason === "attack"
      ? "This request was refused."
      : d.reason === "banned"
        ? "Too many unusual requests came from your connection. Please try again later."
        : d.reason === "unavailable"
          ? "This is briefly unavailable. Please try again in a minute."
          : "Too many requests. Please wait a moment and try again.";
  const h = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  if (d.retryAfterSeconds > 0) h.set("Retry-After", String(d.retryAfterSeconds));
  return new Response(JSON.stringify({ error }), { status: d.status, headers: h });
}

type Handler<R extends Request, A extends unknown[]> = (request: R, ...rest: A) => Response | Promise<Response>;

/**
 * Wrap a route handler: the limit runs first; a refusal answers before the
 * handler is called. `account` (optional) names the signed-in account and its
 * plan when the route has a cheap way to know them. Composes inside the request
 * log (withRequestLog(route, withRouteLimit(id, handler))), so a refusal is
 * still one logged request.
 */
export function withRouteLimit<R extends Request, A extends unknown[]>(
  route: RouteLimitId,
  handler: Handler<R, A>,
  options: { account?: (request: R) => Promise<{ id: string; plan?: PlanTier } | null> } = {},
): (request: R, ...rest: A) => Promise<Response> {
  return async (request, ...rest) => {
    const who = options.account ? await options.account(request).catch(() => null) : null;
    const d = await checkRouteLimit({
      route,
      headers: request.headers,
      url: request.url,
      accountId: who?.id ?? null,
      plan: who?.plan,
    });
    if (!d.allowed) return refusalResponse(d);
    return handler(request, ...rest);
  };
}

/**
 * The server-action form: same check, headers from the ambient request. Returns
 * the refusal (the action maps it to its own friendly message) or null.
 */
export async function guardRouteAction(
  route: RouteLimitId,
  who: { accountId?: string | null; plan?: PlanTier } = {},
): Promise<RouteLimitRefusal | null> {
  const h = await requestHeaders();
  const d = await checkRouteLimit({ route, headers: h, accountId: who.accountId ?? null, plan: who.plan });
  return d.allowed ? null : d;
}

/** The message a server action shows for a refusal. */
export const ROUTE_LIMIT_MESSAGE = "Too many requests. Please wait a moment and try again.";
