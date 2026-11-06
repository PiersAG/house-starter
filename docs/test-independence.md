# Tests that behave the same locally and in CI

app-business-core #740; Matt Murphy #208: "tests that depend on other tests or not tests
their assumptions" and "the timeout you never thought about triggers the race condition
that never reproduces locally". Held by `tests/unit/test-independence.test.ts`.

## Each test brings its own data

- **Its own account.** A browser test makes its account with `uniqueEmail(testInfo, label)`
  (`tests/support/browser.ts`), never a fixed address. A retry gets a new one too.
  Exceptions are listed, with the reason, in `FIXED_ACCOUNTS` in the rule test (the layout
  guardrail's addresses are drawn in its screenshots).
- **Its own client address.** Sign-in and sign-up are limited per address. A test sends
  `addressFor(testInfo, label)` (or `ownAddress(page, testInfo)` for a browser page), so
  no test spends another's budget. No fixed `203.0.113.x` addresses in specs.
- **No forced order.** No `mode: "serial"`. A spec that needs setup for several tests
  makes it in `beforeAll` with unique values, and its tests only read it.
- **Random order.** The unit suite runs shuffled on every run (`vitest.config.ts`). A
  failure prints its seed; `npx vitest run --sequence.seed=<seed>` replays that order.
  A test that reads rows clears or plants its own first.

## No timing guesses

- **Wait for the thing, not for a time.** No `waitForTimeout`. Use `expect(...).toBeVisible()`,
  `waitForURL`, `waitForResponse` or `expect.poll`. A sleep (`setTimeout` in a promise) is
  allowed only on a line that says `// timing-safe: <why>`, or in a file listed in `POLLING`
  as a poll interval inside a loop that checks real state.
- **A chosen time limit.** Unit tests have 30 seconds (`testTimeout`), not the 5-second
  default that database-heavy tests passed only on an idle machine. A test that needs more
  sets its own.
- **Flaky is a failure.** A browser test that fails and then passes on its retry fails CI
  (`failOnFlakyTests`): it is a race, and the retry hid it.
- **Slow devices.** The correctness gate runs the first-visit journeys on a slow connection
  with a slowed processor ([correctness-gate.md](correctness-gate.md)), where a hidden race
  shows up.

## Found and fixed when the rule was written (Dispatch AQ, 2026-11-04)

- Four session specs ran in a forced order on one shared account; two specs shared one
  client address across files (`security-page` and `injection-probe`, `billing-pages` and
  `return-path`). All now use their own.
- `email-events-both-states` read rows earlier tests wrote; `audit-and-access` relied on an
  earlier test's tenant access and on a non-empty table; both now plant their own.
- `migration-changes` and the backup tests ran close to the 5-second default and failed under
  load.
