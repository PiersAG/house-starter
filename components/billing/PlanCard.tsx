// The owner's plan, on /dashboard/settings (app-business-core issue 375): the
// trial's days left with a Subscribe button during the trial, so an owner who
// wants to pay early does not have to wait for the trial to lapse; Manage
// billing once subscribed. Rendered only when this app sells a subscription —
// an app that declared none shows nothing here.

import { catalogDb } from "@/lib/catalog";
import { isSubscriptionBillingActive } from "@/lib/billing/routes";
import { getSubscriptionByUserId } from "@/lib/billing/subscriptions";
import { describePlan } from "@/lib/plan-status";
import { ReactivateActions } from "@/app/reactivate/ReactivateActions";

/** `csrfToken`: this session's request token (lib/csrf.ts), for the pay buttons. */
export async function PlanCard({ userId, csrfToken }: { userId: string; csrfToken: string }) {
  if (!isSubscriptionBillingActive()) return null;
  const plan = describePlan(await getSubscriptionByUserId(catalogDb, userId));
  return (
    <section
      aria-labelledby="plan-heading"
      className="mt-8 rounded border border-border p-4"
    >
      <h2 id="plan-heading" className="text-lg font-semibold text-text-primary">
        {plan.title}
      </h2>
      <p className="mt-1 text-sm text-text-secondary">{plan.detail}</p>
      {plan.actions.length > 0 ? (
        <ReactivateActions actions={plan.actions} csrfToken={csrfToken} />
      ) : null}
      <p className="mt-4 text-sm">
        <a
          href="/refund-policy"
          className="font-medium text-primary hover:underline"
        >
          Refund policy
        </a>
      </p>
    </section>
  );
}
