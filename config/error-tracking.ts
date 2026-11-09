// Error tracking with Sentry (PiersAG/app-business-core#761, #806; decision
// #700, settled 2026-11-02: Sentry, free Developer plan, EU data region, one
// project per app). The ONLY file a per-app build edits to switch it on.
//
// A PER-APP SWITCH, like `subscriptionActive` in config/billing.ts: it is not a
// capability in the capability model's sense (it owns no pages, menu entries or
// settings), but it is tested in both states the same way — CI flips it with
// `node scripts/set-flag.mjs --flag error_tracking --state on|off`
// (ci.yml `error-tracking-matrix`).
//
// OFF (the template default), or ON with no usable SENTRY_DSN: nothing is sent
// anywhere, the browser report route answers 404, the server may not open a
// connection to Sentry, and every page works as before. ON with an EU DSN
// (https://<public key>@o<org>.ingest.de.sentry.io/<project>): server errors,
// error-level log lines, the cross-customer access alert and browser errors
// (relayed through the app's own /api/error-report) go to Sentry, stripped of
// personal data first (lib/observability/sentry.ts).
//
// THE FREE PLAN. 5,000 errors a month for the whole Sentry organisation. The
// limits below keep one app inside it: at most `dailyBudget` events a day
// across every server instance (counted in the shared rate-limit store; browser
// reports have their own smaller share, so forged ones cannot crowd out the
// server's errors), the
// same error sent once per `dedupeWindowMinutes` per instance and then only a
// `repeatSampleRate` share of its repeats, and at most `maxEventsPerHour` per
// instance so one burst cannot spend the day's budget. The cross-customer
// access alert is never sampled or budgeted away (it has its own cap).
// tests/unit/sentry-dsn.test.ts holds the arithmetic.

export interface ErrorTrackingConfig {
  /** The switch. Off: nothing is sent. */
  enabled: boolean;
  /** Events a day for this app, all instances together (shared store). */
  dailyBudget: number;
  /**
   * The part of the day's budget browser reports may use. Anyone can post to
   * /api/error-report, so browser reports have their own share and their own
   * hourly cap: a flood of forged reports cannot crowd out the server's errors.
   */
  browserDailyBudget: number;
  /** Events an hour from one server instance (browser reports: half of it, counted apart). */
  maxEventsPerHour: number;
  /** How long one instance waits before sending the same error again in full. */
  dedupeWindowMinutes: number;
  /** Share (0–1) of repeats inside the window that are still sent. */
  repeatSampleRate: number;
  /** Cross-customer access alerts an hour from one instance. */
  maxCrossTenantAlertsPerHour: number;
  /** Browser reports one page sends before it stops. */
  browserMaxReportsPerPage: number;
}

export const errorTrackingConfig: ErrorTrackingConfig = {
  enabled: false,
  dailyBudget: 150,
  browserDailyBudget: 50,
  maxEventsPerHour: 20,
  dedupeWindowMinutes: 60,
  repeatSampleRate: 0.1,
  maxCrossTenantAlertsPerHour: 30,
  browserMaxReportsPerPage: 5,
};

/** The Sentry free (Developer) plan's monthly error allowance. */
export const SENTRY_FREE_PLAN_ERRORS_PER_MONTH = 5000;
