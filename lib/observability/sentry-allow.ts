// The fixed words a quoted value in an error message may keep on its way to
// Sentry (lib/observability/sentry-scrub.ts; Dispatch AT review 2, CEO ruling
// 2026-11-09). Kept only on an exact, whole, case-sensitive match. The setting
// names come from .env.contract through sentry-allow.generated.ts; these are
// the subscription status words the app stores verbatim from Stripe
// (lib/schema.ts `subscriptions.status`): Stripe's full, fixed list of
// subscription statuses.

export const SUBSCRIPTION_STATUSES: readonly string[] = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
];
