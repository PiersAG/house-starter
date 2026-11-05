# App-runtime observability (la-a-uptime-monitoring)

Every app built from house-starter inherits three things so that "is this app
up?" and "did it just error?" are answerable without watching a live log.

## 1. Deep health endpoint — `GET /api/health`

A **core** route (no capability flag, not under `/dashboard`), so it is reachable
with every capability OFF and without a session. The middleware exemption is
pinned by `tests/unit/health-route-exempt.test.ts`.

It is deliberately **not a bare 200**. It runs a real `SELECT 1` against the
database and returns a structured report:

```json
{
  "status": "ok",              // "ok" (200) | "degraded" (503)
  "checks": [{ "name": "database", "ok": true, "critical": true }],
  "lifecycle_state": "LIVE_EVAL",
  "commit": "abc123",
  "recent_errors_1h": 0,
  "time": "2026-07-23T12:00:00.000Z"
}
```

`status: degraded` → HTTP **503** when a critical check fails. The external
prober treats an SSO 302 or a 5xx as **RED** — a redirect that never reached the
app is not "up".

Assembler: `lib/health/checks.ts` (pure, dependency-injected, unit-tested).
DB probe: `lib/health/db-ping.ts`.

## 2. Durable error sink

Vercel's live-tail log is ephemeral. `lib/observability/error-log.ts` persists
structured errors to the app's **own database** (`error_events` table) so they
survive past the tail window and can be counted by `/api/health`.

- Written automatically by `instrumentation.onRequestError` for every
  server-side error.
- `recordError(...)` can also be called from any handler's `catch`.
- Never throws (observability must not create a second error).
- **Build-not-buy** (settings-registry-spec §7): kept in-house rather than
  Sentry SaaS so error payloads (potential PII) stay inside tenant DB isolation
  with no external sub-processor/DPA. A richer tool can layer on later — it
  has: section 4 sends a scrubbed copy to Sentry, and this table stays the record.

## 3. Alerting

The external prober (`agents/operate/app_prober.py` in app-business-core) probes
every app that has a live URL, with the Vercel protection-bypass header, and on
RED (a) fails its scheduled workflow so GitHub emails the CEO and (b) writes an
alert to the dashboard. A dedicated phone-push channel is a tracked follow-up.

## 4. Error tracking — Sentry (app-business-core issues 761 and 806)

Decision 700 (settled 2026-11-02): Sentry, on its free Developer plan, in its
EU data region, one project per app. It is the **second destination**: the
durable error log (section 2) and the structured log keep working exactly as
before, switch on or off.

**The switch.** `config/error-tracking.ts` `enabled` — off in the template. It
is a per-app switch tested in both states (`ci.yml` `error-tracking-matrix`,
`tests/unit/error-tracking-both-states.test.ts`). Off, or on with no usable
`SENTRY_DSN`: nothing is sent anywhere, `/api/error-report` answers 404, the
server may not connect to Sentry (`lib/egress.ts`), and nothing else changes.

**What goes, when on and connected** (`lib/observability/sentry.ts`):

| Event | From | In Sentry |
|---|---|---|
| Every exception the durable error log records | `recordError` (server render and route errors, outside-service failures) | grouped by stack trace |
| Every error-level structured log line | `logEvent` | grouped by event name (`log` + event) |
| The cross-customer access alert | `lib/tenant/access-log.ts` | its own issue: level fatal, tags `alert=cross_tenant_access`, `priority=high`, never sampled |
| Browser errors | `components/ErrorReporter.tsx` → `/api/error-report` | grouped by stack trace, with the browser's name and version |
| Rage clicks (issue 736): 3 clicks on one control within a second | `components/ErrorReporter.tsx` → `/api/error-report` | a warning, grouped by page and control (named by tag, id and test id, never its text) |

Each event carries the error's type, message and stack frames, the page path,
the method, the request id, the release (commit) and the environment, and the
signed-in account's opaque id (so Sentry counts the accounts an issue reached).

**What never goes.** Emails, names, cookies, headers, request or response
bodies, IP addresses, query strings, form contents. The event has no
`request`, `extra` or `breadcrumbs` part. Free text is scrubbed first
(`lib/observability/sentry-scrub.ts`, every rule tested in
`tests/unit/sentry-scrub.test.ts`); log-line fields go only as numbers,
booleans and short codes.

**Only the EU address.** `SENTRY_DSN` is used only when it is
`https://<public key>@o<org>.ingest.de.sentry.io/<project>`
(`lib/observability/sentry-dsn.ts`); any other address counts as unset.

**The page policy never names Sentry.** The browser posts to the app's own
`/api/error-report` (same origin only, 16 KB, one fixed shape, its own route
limit); the server scrubs and sends on. So `lib/csp.ts` is unchanged in both
states.

**The free plan's 5,000 errors a month.** `dailyBudget` 150 events a day across
all instances (one counter in the shared rate-limit store, ≈4,650 a month),
`maxEventsPerHour` 20 per instance, the same error once an hour per instance
and then 10% of its repeats, at most 5 browser reports per page. Sentry
answering 429 pauses sending. The cross-customer alert has its own cap (30 an
hour per instance) and is never budgeted away.

**Health.** While the switch is on, `/api/health` shows a non-critical
`error_tracking` check: not ok when `SENTRY_DSN` is missing or not an EU
address.

**Switching it on for an app** (at its build, once the CEO has made its Sentry
project):

1. `node scripts/set-flag.mjs --flag error_tracking --state on`
2. `npm run legal:render` — Sentry becomes "In use" on the subprocessor list
   and in the privacy policy.
3. Set `SENTRY_DSN` (the project's Client Keys → DSN) in the app's Vercel
   project, Production only (preview errors would spend the same monthly allowance).

The Sentry-side settings (EU region, IP addresses not stored, the alert rules)
are in app-business-core `wiki/policies/error-tracking.md`.
