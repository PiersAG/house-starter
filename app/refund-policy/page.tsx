// Public refund policy (app-business-core issue 354, Matt Murphy item 138): linked
// on the Stripe payment page before the customer pays, and from the owner's plan
// card. The words live in config/refund-policy.ts.
//
// Part of the subscription-billing surface (lib/billing/routes.ts): an app that
// sells no subscription has no refund policy, so the page is ABSENT (404) — at
// the edge, and here as defence in depth.

import Link from "next/link";
import { notFound } from "next/navigation";
import { isSubscriptionBillingActive } from "@/lib/billing/routes";
import { refundPolicy, refundPolicyParagraphs } from "@/config/refund-policy";

export const metadata = {
  title: "Refund policy",
  description: "How cancelling and refunds work for your subscription.",
};

export default function RefundPolicyPage() {
  if (!isSubscriptionBillingActive()) notFound();
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold text-text-primary">
        Refund policy
      </h1>
      <p className="mt-2 text-sm text-text-secondary">
        Last updated {refundPolicy.updated}.
      </p>
      {refundPolicyParagraphs().map((p) => (
        <p key={p} className="mt-4 text-text-secondary">
          {p}
        </p>
      ))}
      <p className="mt-8">
        <Link
          href="/contact"
          className="font-medium text-primary hover:underline"
        >
          Contact us
        </Link>
      </p>
    </main>
  );
}
