# The load test before launch

**Ticket:** app-business-core #356 · **Tool:** k6, free and open source, no account (CEO ruling on #705)

## What it does

On every pull request, GitHub's runner builds the app, serves it on that runner, and k6 does four things at once:

- 100 virtual users sign up, sign in and keep using the dashboard and settings pages, pausing like people do;
- new accounts keep signing up while the 100 stay on, so a database is made at full load;
- one address floods sign-up and the health check, which must be refused with 429 and `Retry-After`;
- another website's write and its preflight are sent, which must stay refused with no CORS header.

The whole run is 4 minutes: 1 minute for users to arrive, 3 minutes at full strength. The job is part of **All CI checks passed**, so it blocks every merge in the template and in every app built from it. The result is the job's summary and one comment on the pull request, updated on each push.

## What passes

Everything is in `config/load-test.ts`; `scripts/load/gate.ts` judges it. Over the whole run, sign-up included: under 1% of requests answered outside their expected status, 95% of requests within 1.5 seconds, and no server error. A run that did not reach 100 users, all sign-ups, the flood or the CORS requests fails: not reaching the test is not a pass.

The report also names the limiting component, as Matt Murphy #3 asks: the slowest step, and whether the app's process used up its core.

## Requirements carried

| Requirement (verbatim) | Source | Where |
|---|---|---|
| "Use tools such as k6 or Artillery to simulate at least 100 concurrent users before launch" | Matt Murphy #3 | `concurrentUsers: 100`, with sign-up in every user's journey (each sign-up makes a database); on every PR, so before launch |
| "identify the limiting component, and correct failures before they affect customers." | Matt Murphy #3 | the report's **Limiting component** line; a failure blocks the merge |
| "so cores and rate limiting are configured and tested under a load" ("cores" is the transcript's mis-hearing of CORS) | Matt Murphy #243 | `flood` and `cors`, both while the 100 users run |
| "you run your deploy and staging with production equivalent traffic first" | Matt Murphy #243 | a production build (`next build`, `next start`) on each branch, which is the staging of this release path; see the limits below |
| "load testing before launch not we'll see what happens but actual simulated traffic" | Matt Murphy #326 | real requests to real routes for four minutes |

## Where it runs

Only on a locally served copy: this runner, or the proof app the factory builds fresh from the template. It never runs against a live customer app, and never on a paid load-testing service. `assertLoadTarget` refuses any address but the machine's own, the k6 script checks again, and `scripts/load/run.sh` refuses to start where `VERCEL_ENV` is set.

Run it on GitHub, not a laptop: 100 users and a flood are heavy. For a small local try, lower `concurrentUsers` and `holdSeconds` in a scratch copy; the gate then fails the run, as it should.

## What it cannot tell you

- **The database is a local file.** Each sign-up makes a file, not a Turso database, so Turso's own speed and limits are not measured. Testing those needs a live service, which this test must not touch.
- **One process, one machine.** Vercel runs many copies of the app. This test is stricter on processor and memory than production, and says nothing about cold starts.
- **Speed varies between runs.** Runners are shared: two runs of the same code measured 95% of requests within 99 ms and 254 ms. The bar of 1,500 ms leaves room for that.
- **Rate limits run at ten times their deployed values** (`SAFE_TEST_FACTOR`), and in memory, not in the shared store. The flood is sized to pass them anyway. The sign-up limit is the same as deployed.
- **The breached-password lookup is skipped**, as in every test (`lib/password-breach.ts`), so sign-up here does not include that outside call.
