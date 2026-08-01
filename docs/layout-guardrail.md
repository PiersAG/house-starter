# The layout guardrail

**What it is:** a blocking CI gate that fails the build when a page starts
scrolling sideways, or when its layout stops matching a committed picture of
itself. Card 2.3.51.

**Why it exists:** three cards built this template's layout — container queries
and fluid type as the default build path (2.3.15), one responsive nav (2.3.49),
one responsive data table (2.3.50). None of them left anything behind that would
notice the next feature quietly undoing the work. This does.

---

## The two checks

Per guarded page, per gated width, on every push:

### 1. No horizontal overflow — the hard gate

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

Deterministic. No baseline, no tolerance, no maintenance, and no way to produce
a false failure: either the document is wider than the space it has or it is
not.

This is the failure worth gating. One element wider than the screen does not
just look untidy — it pushes the **document** sideways, so the fixed bottom tab
bar slides off, and every other element on the page is laid out against
something wider than the phone. One bad table breaks the whole screen.

`clientWidth`, not `window.innerWidth`. `innerWidth` includes the vertical
scrollbar, so a document exactly `innerWidth` wide is already overflowing by the
scrollbar's width and the looser comparison would call it clean. The Spec C4
advisory suite (`tests/responsive/`) compares against `innerWidth`; this gate is
deliberately the stricter of the two.

### 2. The layout matches its baseline — the diff

A committed PNG per page per width, compared with Playwright's
`toHaveScreenshot`, at a 1% pixel tolerance.

It catches what the overflow assertion cannot see: a nav that stopped switching
to its bar arrangement, a column ladder that stopped laddering, a section that
collapsed to nothing. It cannot tell you whether a layout is **good**, only
whether it **changed** — which is the job. An intended change is one baseline
regeneration away.

### What is deliberately NOT gated

"Fits, but is cramped." That is a human glance. A machine asserting aesthetic
quality produces a gate people learn to ignore, which is worse than no gate.

---

## What is guarded

| | |
|---|---|
| **Pages** | `/dashboard`, `/account` |
| **Widths** | 320 (phone), 768 (tablet), 1280 (desktop) |
| **Spec** | `tests/layout/layout-guardrail.spec.ts` |
| **Project** | `layout-guardrail` in `playwright.config.ts` |
| **Baselines** | `tests/layout/__screenshots__/*.png` |
| **CI step** | "Layout regression guardrail" in `.github/workflows/ci.yml` |

**Two pages, not every route.** Both carry the primary nav, and between them
they cover what the layout run built. Screenshotting every route buys very
little and costs a baseline to review on every change.

**Three widths, not the full five.** The breakpoint contract (Spec C4) is
320 / 390 / 768 / 1280 / 1920 and every width costs a sign-up, two page loads
and two full-page screenshots. 320 is the contract's floor — "where layouts
actually break" — so it is the phone leg here. Adding 390 or 1920 is one line
in `WIDTHS` plus a baseline regeneration.

**A descendant app extends this.** K9Coach guards the same two paths, where
`/dashboard` carries a real data table; a new app adds its own screens to
`PAGES`.

---

## Why it is separate from `tests/responsive/`

`tests/responsive/` is the Spec C4 suite: five widths, overflow + touch targets
+ axe. It is **advisory by CEO ruling** — it reports and does not block — and CI
does not run it at all.

This suite is the opposite: narrow and blocking. They are separate Playwright
projects so that making one of them blocking did not silently make the
touch-target and axe checks blocking too. They overlap on the overflow
assertion, which is the one assertion worth having twice.

---

## Baselines: CI generates them, CI compares them

**The dev machine cannot make baselines.** Playwright 1.60 installs no browser
on Ubuntu 26.04. Even where it could, a screenshot rendered against a different
font stack differs from CI's by thousands of pixels, so a locally-made baseline
would fail every CI run after it. `{platform}` is kept in the snapshot filename
as the safety catch: a baseline generated anywhere but Linux lands in a
different file and can never silently replace the one CI compares against.

### Regenerating them

`.github/workflows/layout-baselines.yml` runs `--update-snapshots` on the CI
runner and commits the PNGs back to the branch it ran against. Two triggers:

**1. `workflow_dispatch` — the everyday path.**

```bash
gh workflow run layout-baselines.yml --ref <branch> -f reason="<why>"
```

Or Actions → "Layout baselines" → Run workflow.

GitHub only offers `workflow_dispatch` for workflows that already exist on the
**default branch**. So it does nothing for the branch that introduces the
workflow, or for a branch cut before it merged — which is exactly when the first
baselines have to be made. Hence:

**2. Push a change to `tests/layout/BASELINES.request`.**

A plain text file whose contents are the reason. Works from any branch, because
a push trigger needs nothing on the default branch. The file stays in the repo
as the log of why each regeneration happened.

Either way the PNGs land as a commit on the branch, so the diff is reviewable in
the PR like any other change.

### When to regenerate

- **A new branch added or renamed a guarded page or width** — CI is failing with
  "A snapshot doesn't exist at ...".
- **A layout change is intended.** The guardrail failing is the gate doing its
  job. Regenerating is how you say "yes, that is the new correct layout".
- **Playwright or the runner image moved** — a dependabot bump to
  `@playwright/test` changes the browser build and with it the rasterisation.

**Review the image diff before accepting.** An accepted baseline is an accepted
layout; a rubber-stamped regeneration is how a real regression gets blessed into
main.

**Do not regenerate on main to clear a red guardrail.** A red guardrail on main
is a regression that reached main. Fix the layout.

---

## When it fails

The CI job uploads `playwright-report/` and `test-results/` as the
`layout-guardrail-report` artifact, which carries the expected / actual / diff
images. Download it from the run's summary page — without it a baseline failure
is a percentage in a log with no way to see what moved.

**An overflow failure names the page, the width and the overshoot in pixels.**
Start there: something on that page is wider than the space it was given, and
it is usually a fixed width (`w-80`, `min-w-[...]`), a table, or a long
unbreakable string.

---

## Keeping the baselines stable

Two things make a screenshot gate useless: a picture that changes on its own,
and a picture so tolerant it catches nothing. The suite handles the first
deliberately, and the reasoning matters if you extend it:

- **The account carries a fixed name.** `/dashboard` renders
  `session.user.name ?? session.user.email`. A generated email would be a
  different string every run — and a different *length*, which at 320px is a
  different number of wrapped lines and so a genuinely different layout.
- **Same-length email addresses per width**, for the same reason.
- **Sign up, or sign in if the account exists.** CI retries a failed test once
  against the database the first attempt already wrote to.
- **Anything genuinely time-dependent is masked**, not left to drift — see
  K9Coach's copy, where the dogs table's "Added" column is today's date.
  Masking paints over the text and keeps the cell's geometry in the comparison,
  which is the part this gate is about.
