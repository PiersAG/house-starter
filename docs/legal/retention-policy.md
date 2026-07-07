# Retention policy

STUB — replace before requesting LIVE-OPEN

Replace this scaffold with an app-specific retention policy before requesting LIVE-OPEN. The LIVE-OPEN gate checks existence + minimum length + required heading; the CEO checks adequacy.

## Retention periods

Name every category of personal data the app stores and the retention window for each. Retention is either "keep for X, then delete" or "keep while the account exists, then delete on account closure + Y grace period" — be concrete.

| Category | Retention | Deletion trigger | Notes |
|---|---|---|---|
| _e.g. account (email, hashed password)_ | Until account deleted + 30 days | Account deletion via `/settings/delete` | Grace period is for user re-activation; not shared with recovery flows. |
| _e.g. login-attempt log_ | 90 days | Age > 90 days | Used for rate-limiting + security investigation. |
| _e.g. Stripe customer id + subscription state_ | Until subscription cancelled + 7 years | Compliance retention window | Retained for tax/audit; not used for marketing. |

## Deletion mechanism

State how deletion actually happens: is it a scheduled job, a per-request delete, a cascade in the DB schema? Point to the migration or job that implements it.

## Backups

Backups are personal data too. State how long backups are retained and how deletion propagates to them. If deletion from backups is impossible (e.g. an append-only WAL held for point-in-time recovery), record the compensating control (e.g. encryption + backup-window ≤ retention window).

## Anomalies

Record any category that is retained longer than a naïve reading of the retention window would suggest, and why (legal hold, audit, unresolved investigation).

## Review

Record when this policy was last reviewed. Review annually and whenever a new data category is added.
