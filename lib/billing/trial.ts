// Auto-trial on signup (step 6, Part B). The step-5 paywall blocks any owner
// without an active subscription — which would instantly lock a just-registered
// owner out of their own app. Giving every new owner a trial on signup fixes
// that, using the WP1 gate as-is (no gate change).
//
// The trial length is a settings-registry key — owner-configurable, factory
// default 14 days, kernel/subscription_billing-flagged so it always resolves —
// read via getSetting, never a literal here.
//
// NOT in scope (a separate lifecycle card): card collection, a read-only-on-
// expiry state, a retention countdown, deletion. On expiry the step-5 hard gate
// simply applies.

import { getSetting } from "@/lib/settings/resolver";
import {
  getSubscriptionByUserId,
  upsertSubscriptionByUserId,
} from "@/lib/billing/subscriptions";
import type { AppDatabase } from "@/lib/users";

const DAY_MS = 86_400_000;
const TRIAL_DAYS_KEY = "billing.trial_period_days";

// App-created trial status — deliberately NOT "trialing"/"active", which the
// step-5 gate (lib/billing/gate.ts) allows UNCONDITIONALLY, forever. This trial
// must EXPIRE so the step-5 hard gate applies at trialEndsAt, so it relies on
// the gate's trial-valid path (status ∉ {active,trialing} + trialEndsAt in the
// future → allowed; once trialEndsAt passes → blocked). "incomplete" is a real
// Stripe status (subscription created, not yet paid) — apt for a trial with no
// Stripe payment behind it yet. The checkout webhook overwrites this row (keyed
// by userId) with the real Stripe status when the owner subscribes.
const TRIAL_STATUS = "incomplete";

export interface StartTrialOptions {
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * Start a trial subscription for a newly registered owner. Idempotent-safe: if
 * the user already has any subscription it is left untouched (never clobbers a
 * real or paid subscription). Returns nothing — a failure throws.
 */
export async function startTrialForNewOwner(
  db: AppDatabase,
  userId: string,
  opts: StartTrialOptions = {},
): Promise<void> {
  const existing = await getSubscriptionByUserId(db, userId);
  if (existing) return;

  const days = await getSetting<number>(db, TRIAL_DAYS_KEY);
  const now = opts.now ?? new Date();
  const trialEndsAt = new Date(now.getTime() + days * DAY_MS);

  await upsertSubscriptionByUserId(db, {
    userId,
    status: TRIAL_STATUS,
    trialEndsAt,
  });
}
