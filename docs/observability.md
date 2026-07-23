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
  with no external sub-processor/DPA. A richer tool can layer on later.

## 3. Alerting

The external prober (`agents/operate/app_prober.py` in app-business-core) probes
every app that has a live URL, with the Vercel protection-bypass header, and on
RED (a) fails its scheduled workflow so GitHub emails the CEO and (b) writes an
alert to the dashboard. A dedicated phone-push channel is a tracked follow-up.
