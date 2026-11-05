# The correctness gate

The non-security half of "production-ready" (app-business-core #413, UIX.20). One named
CI job, **Correctness gate (accessibility, awkward input, browsers)**, inside "All CI
checks passed", so it blocks every merge in this template and in every app built from it.
Its legs, and where each runs:

| Leg | What it checks | Where |
|---|---|---|
| Accessibility | WCAG 2.2 AA on every page, signed in and signed out: axe (including 4.5:1 text contrast), names for every image, button, field and link read from the browser's accessibility tree, one main landmark and one top heading with no skipped levels, a title and a language. Desktop and a phone width. A Tab-only walk of every page: every control reached, each with a visible focus and none hidden behind anything. Menus work from the keyboard; the session dialog keeps focus inside it. (#720) | `tests/a11y/`, projects `a11y`, `a11y-phone` |
| Awkward input | Every field of every form with apostrophes, 1,000 and 10,000 characters, nothing, emoji and weird characters (quotes, markup, right-to-left marks, combining marks); every form's submit pressed 47 times; three clicks in the middle of a sign-up; 47 sign-ups at once; 200 MB requests; an apostrophe in a name and an email keeps the account. (#721) | `tests/awkward/`, projects `awkward-*` |
| Browsers and devices | The first-visit journeys in Chromium, Firefox, Safari's engine (WebKit), a 2019 iPhone, a 2019 Android phone on a slow connection (2 s latency, about 50 KB/s) with a processor slowed four times, and a 320 px screen on the same connection. (#721) | `tests/awkward/journeys.spec.ts` |
| Oldest browser | Every script the build ships parses at ES2020, the level of the oldest supported browsers (Chrome and Edge 80, Firefox 74, Safari 13.1). (#721) | `scripts/check-browser-floor.ts`, `config/browser-support.ts` |
| Layout overflow | No page scrolls sideways at 320, 768 and 1280 px. | Layout guardrail step in the `ci` job, `tests/layout/` |
| Visual regression | Pages match their committed screenshots. | Layout guardrail step in the `ci` job; baselines from `layout-baselines.yml` |
| Automated tests | Unit and end-to-end suites; the unit suite runs in random order every run, and a browser test that passes only on its retry fails CI. (#740) | `ci` job; [test-independence.md](test-independence.md) |

## Every page, every form

The suites read their lists from `tests/support/routes.ts` (pages) and
`tests/support/forms.ts` (forms). `tests/unit/browser-suite-coverage.test.ts` walks `app/`
and fails when a page or a form exists that a list does not name: adding a screen means
adding one line there, and the gate tests it from then on. A page that adds a file field
fails `server.spec.ts` until it is listed in `UPLOAD_FIELDS` with a 200 MB test of its own.

## Running it

CI runs it on every pull request. Locally (Chromium only; WebKit and Firefox need system
libraries this laptop does not have):

```
npm run build
E2E_PREBUILT=1 npx playwright test --project=a11y --project=awkward-chromium
npm run check:browser-floor
```

## What it found when it was built (Dispatch AQ, 2026-11-04)

- Two-step set-up sent no CSRF token, so every set-up was refused ("This request could not
  be verified"). Fixed in `app/account/security/TwoStepSetup.tsx`; held by
  `a new account can turn on two-step sign-in`.
- The session-expiry dialog is marked modal but let Tab walk out of it. Fixed in
  `components/session/SessionExpiryWarning.tsx`.
- `/account` jumped from its top heading to a third-level one. Fixed (`EmptyState` takes a
  `level`).
- A 200 MB form submission is refused by Next.js's own 1 MB limit with a 500 of its own. A
  413 needs the edge middleware, a file the factory's safety gate protects: recorded for the
  sign-in area's next dispatch.
