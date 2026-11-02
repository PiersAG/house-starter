# Rate limits

Every route handler and server action in the app has a limit. The limits are written down in one file, `config/rate-limits.ts`, and enforced by `lib/abuse/route-limit.ts` (app-business-core #787, #748).

## The three layers

1. **Hard limits.** Each route group has a fixed number of requests per time window, counted per client address and, where the route knows who is signed in, per account. Going over the limit gets a `429` answer with a `Retry-After` header.
2. **Adaptive limits.** When the app has logged more than 25 server errors in five minutes, every limit is halved until the count falls back. The health reading is cached for 30 seconds on each server instance.
3. **Limits by price plan.** A paying subscriber gets a multiple of the base limit on signed-in routes. Public routes are never raised. Today an app has one price; when price tiers exist (BILL.07, app-business-core #379), each tier becomes one row of `PLAN_MULTIPLIERS`.

## Probing and escalation

- **Probing.** One client or account hitting the same endpoint more than 50 times in one second is probing. It is refused, and it scores heavily.
- **Escalation.** Bad behaviour scores strikes against the client address: hitting a limit, probing, sending an attack payload, or a refused sign-in. Past 5 strikes in ten minutes, the client's limits are cut to a quarter. Past 15, the client is banned for 15 minutes. Strikes are weighted by what the client did, so a client sending attack payloads is banned sooner than one that is just busy.
- **Attack payloads.** The edge firewall's rule set (`config/edge-firewall.ts`) also runs inside the app on every limited route. An SQL-injection or path-traversal payload gets a `403` even when no edge firewall sits in front.

## Where the counts live

The counts live in the shared store (`RATE_LIMIT_STORE_URL`, Upstash Redis today). A count is one store command. Each request uses about four or five: the ban check, the strike count, the per-client count, the probe count and, if signed in, the per-account count.

- **Store not configured on a deployed instance:** the app refuses to serve (`lib/rate-limit.ts`).
- **Store fails while running:** the route is still served and the failure is logged (`rate_limit_store_error`). A blip in the store must not take the whole app offline.
- **The sign-in limits** (`lib/auth-rate-limit.ts`) keep their own stricter rules and run behind these limits.

## Safe test environment

An end-to-end suite is one client, so in the safe test environment only (no `VERCEL_ENV`, and `RATE_LIMIT_ALLOW_IN_MEMORY=true`) every limit and escalation threshold is ten times higher. Attack payloads are refused exactly as on a deployed instance.

## Adding a route

- A new `route.ts` wraps its handler: `export const POST = withRouteLimit("app.default", handler)`. Inside the request log, this becomes `withRequestLog(path, withRouteLimit(id, handler))`.
- A new server action calls `guardRouteAction(id)` first.
- Use `app.default`, or add a group of your own to `ROUTE_LIMITS`.
- `tests/unit/route-limit-coverage.test.ts` fails the build if a route or server-action file has no limit.

## Events

These events go to the security log (`lib/security-log.ts`), with the client address:

- `route_rate_limited` (once per client per window, not once per refused request);
- `abuse_throttled`;
- `abuse_banned`;
- `attack_request_refused`;
- `rate_limit_store_error`.

The DDoS playbook (app-business-core `wiki/policies/ddos-playbook.md`) says what to do with them.
