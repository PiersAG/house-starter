// Rate limits as architecture (PiersAG/app-business-core#787, #748, #754).
//
// EVERY ROUTE HAS A LIMIT. This file is the one place an app's whole request
// budget is written down: one entry per route group, each with a hard limit
// (layer 1 — "fixed number of requests per time window, hit the wall, get a
// 429"), scaled by the caller's price plan (layer 3 — "the rate limit becomes
// the pricing architecture") and by the system's health (layer 2 — "the limits
// adjust based on the system's health"). lib/abuse/route-limit.ts enforces it;
// tests/unit/route-limit-coverage.test.ts fails the build when a route file or
// a server-action file exists that is not wired to a limit named here, so a
// generated feature cannot ship an unlimited endpoint.
//
// The sign-in limits in lib/auth-rate-limit.ts stay as they are (tighter, and
// counted per account as well as per client). These route limits sit IN FRONT
// of them on the same routes: the route limit and the escalation (throttle,
// then a temporary ban) apply to every request, the auth limits to attempts.
//
// The VALUES are the lever each app tunes; the EXISTENCE of a limit on every
// route is required (quality baseline, rate limiting on every route).

/** One fixed window: at most `limit` requests per `windowSeconds`. */
export type Window = { limit: number; windowSeconds: number };

export type RouteLimit = {
  /** Counted per client address. Every route has one. */
  perClient: Window;
  /** Counted per signed-in account as well, where the route knows the account. */
  perAccount?: Window;
  /**
   * A public data endpoint (no sign-in needed). Public routes are the scraping
   * target (Matt Murphy #283: "your public data endpoints to prevent any bot
   * scraping"), so they are never raised by a price plan.
   */
  public: boolean;
};

/**
 * The route groups. A route handler or server action names exactly one. Ids are
 * stable strings: they are the counter keys in the shared store.
 */
export const ROUTE_LIMITS = {
  // Sign-in surfaces. The per-attempt limits live in lib/auth-rate-limit.ts;
  // this is the outer budget and the escalation.
  "auth.signin": { perClient: { limit: 30, windowSeconds: 60 }, public: true },
  "auth.signup": { perClient: { limit: 20, windowSeconds: 60 }, public: true },
  "auth.password-reset": { perClient: { limit: 20, windowSeconds: 60 }, public: true },
  "auth.mfa": {
    perClient: { limit: 30, windowSeconds: 60 },
    perAccount: { limit: 30, windowSeconds: 60 },
    public: false,
  },
  // Signed-in account pages' writes (password change, sign out everywhere, MFA off).
  "account.write": {
    perClient: { limit: 30, windowSeconds: 60 },
    perAccount: { limit: 20, windowSeconds: 60 },
    public: false,
  },
  // Billing. Checkout and the portal each create a Stripe session (an outside
  // call that costs quota); the webhook is signed by Stripe and comes from
  // Stripe's addresses, so it gets a high ceiling that only a flood reaches.
  "billing.session": {
    perClient: { limit: 10, windowSeconds: 60 },
    perAccount: { limit: 10, windowSeconds: 60 },
    public: false,
  },
  "billing.webhook": { perClient: { limit: 600, windowSeconds: 60 }, public: true },
  // Settings and tenant reads/writes.
  "settings.read": {
    perClient: { limit: 120, windowSeconds: 60 },
    perAccount: { limit: 120, windowSeconds: 60 },
    public: false,
  },
  "settings.write": {
    perClient: { limit: 30, windowSeconds: 60 },
    perAccount: { limit: 30, windowSeconds: 60 },
    public: false,
  },
  "tenant.read": {
    perClient: { limit: 120, windowSeconds: 60 },
    perAccount: { limit: 120, windowSeconds: 60 },
    public: false,
  },
  // Public machine endpoints. The uptime prober calls health a few times an
  // hour; browsers send CSP reports in bursts.
  "public.health": { perClient: { limit: 60, windowSeconds: 60 }, public: true },
  "public.csp-report": { perClient: { limit: 120, windowSeconds: 60 }, public: true },
  "public.security-txt": { perClient: { limit: 30, windowSeconds: 60 }, public: true },
  // The daily retention job (app-business-core issue 722): Vercel's scheduler calls
  // it once a day with CRON_SECRET; a few a minute is already far more than enough.
  "jobs.retention": { perClient: { limit: 5, windowSeconds: 60 }, public: true },
  // The email provider's delivery reports (app-business-core issue 757): one per
  // message sent, delivered or bounced, from the provider's own servers.
  "email.events": { perClient: { limit: 600, windowSeconds: 60 }, public: true },
  // The default for any feature route a build adds: a generated route names
  // this (or a group of its own added here) — never nothing.
  "app.default": {
    perClient: { limit: 120, windowSeconds: 60 },
    perAccount: { limit: 120, windowSeconds: 60 },
    public: false,
  },
} as const satisfies Record<string, RouteLimit>;

export type RouteLimitId = keyof typeof ROUTE_LIMITS;

/**
 * Layer 3 — limits by price plan (Matt Murphy #186: "free users get 100 calls per
 * day builder access gets 500 calls per day enterprise they get a billion the
 * rate limit becomes the pricing architecture"). A plan multiplies the hard
 * limits of every NON-public route for a signed-in account. Today an app has one
 * price (BILL.07, #379, is the research into tiers); when tiers land, each tier
 * is a row here, named as the subscription's plan is named.
 */
export const PLAN_MULTIPLIERS = {
  // Signed out, or signed in with no live plan.
  none: 1,
  // In the free trial.
  trial: 1,
  // A paying subscriber.
  subscribed: 2,
} as const satisfies Record<string, number>;

export type PlanTier = keyof typeof PLAN_MULTIPLIERS;

/** A subscription's state (lib/plan-status.ts kinds) → its rate-limit tier. */
export function planTierFor(kind: string | null | undefined): PlanTier {
  if (kind === "subscribed") return "subscribed";
  if (kind === "trial") return "trial";
  return "none";
}

/**
 * Layer 2 — adaptive limits from the system's health. When the app has logged
 * more than `degradedErrors` server errors in the last `windowSeconds`, every
 * limit is multiplied by `degradedFactor` until the count falls back (Matt
 * Murphy #186: "instead of a fixed wall the limits adjust based on the system's
 * health"). The health reading is cached for `cacheSeconds` per instance, so it
 * costs one query per instance per half-minute, not one per request.
 */
export const HEALTH_ADAPTIVE = {
  windowSeconds: 300,
  degradedErrors: 25,
  degradedFactor: 0.5,
  cacheSeconds: 30,
} as const;

/**
 * Probing (Matt Murphy #170: "a user hitting the same endpoint 50 times per
 * second they aren't using it they're probing"). Counted per client (and per
 * account) per route group in one-second windows, separately from the hard
 * limit, so a burst is caught even when the minute budget has room left.
 */
export const PROBE = { limit: 50, windowSeconds: 1 } as const;

/**
 * Escalation (Matt Murphy #12: "ip-based anomaly detection that escalates from
 * throttle to temporary ban based on behaviour not just volume"). Each kind of
 * bad behaviour scores strikes against the client; strikes decay with the
 * window. Past `throttleAt` the client's limits are cut to `throttleFactor` of
 * normal; past `banAt` every request from it is refused for `banSeconds`.
 *
 * Behaviour, not just volume: hitting a limit is one strike, but probing, a
 * request for a known attack path, or a refused sign-in score more — a client
 * that is under every limit and still asks for /.env is banned sooner than one
 * that is merely busy.
 */
export const ESCALATION = {
  strikeWindowSeconds: 600,
  throttleAt: 5,
  throttleFactor: 0.25,
  banAt: 15,
  banSeconds: 900,
  strikes: {
    limit_hit: 1,
    probe: 5,
    attack_path: 5,
    auth_refused: 2,
  },
} as const;

export type Behaviour = keyof typeof ESCALATION.strikes;
