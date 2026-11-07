# The load test before launch

**Ticket:** app-business-core #356 (load-test lines) · **Tool:** CEO decision #705, open

## What is decided here

`config/load-test.ts` records what the load test runs and what passes. Any runner reads it. `tests/unit/load-test-plan.test.ts` holds it to the words of the requirements:

| Requirement (verbatim) | Source | Where |
|---|---|---|
| "Use tools such as k6 or Artillery to simulate at least 100 concurrent users before launch" | Matt Murphy #3 | `concurrentUsers: 100`, with sign-up in every user's journey (each sign-up makes a database) |
| "so cores and rate limiting are configured and tested under a load" | Matt Murphy #243 | `flood`: one address floods sign-up and the health check while the 100 users run; the answer must be 429 with `Retry-After`, never a 5xx |
| "load testing before launch not we'll see what happens but actual simulated traffic" | Matt Murphy #326 | the journey makes real requests to real routes, held for three minutes after a one-minute ramp-up |

What passes: under 1% of requests answered outside their expected status, 95% of requests within 1.5 seconds, and no server error.

## Where it runs

It runs only against a locally built copy, or the proof app the factory builds fresh from this template. It never runs against a live customer app, and never on a paid load-testing service. `assertLoadTarget` refuses any address that is not this machine's loopback.

## What is not built yet

The runner, because which tool runs it (k6, Artillery, Grafana Cloud k6, or none until after launch) is the CEO's decision on #705. The recommendation is k6, the open-source command-line tool. It is free, runs on the machine or the CI runner with no account, and reads a plan like this one directly. Grafana Cloud k6 is the paid hosted version, and is not needed.
