# The signed-in active scan

**Ticket:** app-business-core #533 · **Source:** Matt Murphy #223 — "ZAP should crawl every page, test every form and probe every API endpoint for injection before the first user."

## What runs, and when

| Where | When | What it proves |
|---|---|---|
| `active-scan` job in `.github/workflows/ci.yml` | every pull request and every push to `main`; part of **All CI checks passed**, so it blocks every merge | the app as built has no High finding under attack, signed in |
| `.github/workflows/active-scan-selftest.yml` | when the scan's own parts change, weekly, and on demand | the scan still catches a seeded flaw behind sign-in |

The factory's planted security scan still runs ZAP's **baseline** (signed out, passive rules only, no attack payloads). This scan is the **active** one: it sends attack payloads.

## How a run works (`scripts/dast/run.sh`)

1. The app is built and served on the runner's own loopback (`http://127.0.0.1:3000`) with throwaway values that reach nothing real. The scripts refuse any other address. A live or deployed app is never scanned.
2. `scripts/dast/session.ts` creates a throwaway test account through the app's own sign-up endpoint, signs it in through the login form's endpoint, and checks that a signed-in page answers 200.
3. `scripts/dast/plan.ts` writes ZAP's Automation Framework plan:
   - the session cookie and the request token (`lib/csrf.ts`) are added to every request, so the scan runs signed in and its writes pass the request check;
   - every API route under `app/api` is fed in as an OpenAPI description. The routes are found from the source, so a route the builder adds is scanned next time. Each write gets an example body built from the field names its source validates. The settings route gets a real core setting an owner may write (`PARAM_EXAMPLES`; core is on in every app), so the payloads get past its key lookup;
   - the spider crawls the pages from `/dashboard` and from `/`;
   - ZAP's **active** scan then runs for at most 20 minutes.
   - The scan never sends the requests listed in `SCAN_EXCLUSIONS` (sign-out, sign-in attempts, session revoke), because they would end its own session. Each exclusion carries its reason.
4. `scripts/dast/gate.ts` fails the run on:
   - any **High** finding;
   - a missing or unreadable report, or a report with no scanned site;
   - a ZAP log that never says the active scan finished;
   - a session that no longer opens a signed-in page after the scan (it may have run signed out).

   It also lists every Medium and Low finding, and how many scan requests the app's own rate limits and attack filter refused.

## Rate limits during the scan

The active scan is one client sending thousands of requests. In the safe test environment the route limits are already ten times their deployed values (`SAFE_TEST_FACTOR`). At that level, 863 of a measured 1,475 API attack requests were refused with a 429 before reaching the code (2026-11-04). `RATE_LIMIT_SAFE_TEST_FACTOR` (CI sets `1000`) raises the factor for the scan.

The setting is read only in the safe test environment: no `VERCEL_ENV`, plus the in-memory opt-in. A deployed app keeps factor 1 whatever the variable says (`tests/unit/route-limit-scan-factor.test.ts`). The attack filter (`config/edge-firewall.ts`) stays on exactly as deployed, so the scan measures what production would let through.

## Running it on your own machine

The scan needs Docker. With Docker Desktop, the container reaches the app as `host.docker.internal`, not `127.0.0.1`. Pass `--zap-base http://host.docker.internal:3000` to `scripts/dast/plan.ts` and drop `--network=host` from the `docker run` line.

ZAP's active scan needs several gigabytes of memory. On a laptop that is already short of memory it can stall the machine, so prefer the CI job.
