// What the owner's plan card says (PiersAG/app-business-core#375): during a free
// trial the owner can subscribe early, with the days left shown; once
// subscribed they manage billing; after a failed payment they update their
// card. Pure, so it is unit-tested without a database. The card itself is
// components/billing/PlanCard.tsx, shown on /dashboard/settings only when this
// app sells a subscription.

export type PlanAction = "checkout" | "portal";

export interface PlanRow {
  status: string;
  trialEndsAt: Date | null;
  stripeCustomerId: string | null;
}

export interface PlanView {
  kind:
    | "trial"
    | "trial_ended"
    | "subscribed"
    | "payment_failed"
    | "canceled"
    | "none";
  title: string;
  detail: string;
  actions: PlanAction[];
}

const DAY_MS = 86_400_000;

/** Whole days left until `end`, rounded up (a trial ending in 3 hours has 1 day). */
export function daysLeft(end: Date, now: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}

export function describePlan(
  sub: PlanRow | undefined | null,
  now: Date = new Date(),
): PlanView {
  if (!sub) {
    return {
      kind: "none",
      title: "No plan yet",
      detail: "Subscribe to keep using the app.",
      actions: ["checkout"],
    };
  }
  const portal: PlanAction[] = sub.stripeCustomerId ? ["portal"] : [];
  if (sub.status === "active") {
    return {
      kind: "subscribed",
      title: "Subscribed",
      detail: "Your subscription is active.",
      actions: portal,
    };
  }
  if (sub.status === "past_due" || sub.status === "unpaid") {
    return {
      kind: "payment_failed",
      title: "Payment failed",
      detail:
        "Your last payment didn't go through. Update your card to keep your access.",
      actions: portal.length ? portal : ["checkout"],
    };
  }
  if (sub.status === "canceled") {
    return {
      kind: "canceled",
      title: "Subscription ended",
      detail: "Subscribe again to restore access.",
      actions: ["checkout"],
    };
  }
  const inTrial =
    sub.trialEndsAt !== null && sub.trialEndsAt.getTime() > now.getTime();
  if (sub.status === "trialing" || inTrial) {
    const n =
      sub.trialEndsAt && inTrial ? daysLeft(sub.trialEndsAt, now) : null;
    // A Stripe trial ("trialing") already has a subscription; manage it in the portal.
    const stripeTrial = sub.status === "trialing";
    return {
      kind: "trial",
      title:
        n === null
          ? "Free trial"
          : `Free trial: ${n} day${n === 1 ? "" : "s"} left`,
      detail: stripeTrial
        ? "Your subscription starts when the trial ends."
        : "Subscribe now and you won't lose access when the trial ends.",
      actions: stripeTrial ? portal : ["checkout"],
    };
  }
  return {
    kind: "trial_ended",
    title: "Your trial has ended",
    detail: "Subscribe to keep using the app.",
    actions: ["checkout"],
  };
}
