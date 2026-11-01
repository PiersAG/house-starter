// The app's refund policy (PiersAG/app-business-core#354, Matt Murphy #138:
// "refund policy published AND linked/visible on the checkout before the
// customer pays"). Shown at /refund-policy, linked on the Stripe payment page
// and on the owner's plan card. The factory's copy, with the reasons, is
// app-business-core wiki/policies/billing-refund.md; the Supporter's reply for a
// refund request is docs/support/refund-macro.md.
//
// A per-app build may change the numbers or wording here. The default is
// generous on purpose: a full refund within 14 days of the first payment covers
// the UK consumer cooling-off right (14 days for a digital service, unless the
// customer agreed to start straight away) for any customer, business or not.

export interface RefundPolicy {
  /** Days after the FIRST paid charge in which a full refund is given on request. */
  firstPaymentRefundDays: number;
  /** Working days within which a refund request is answered. */
  replyWorkingDays: number;
  /** When the policy last changed (shown on the page). */
  updated: string;
}

export const refundPolicy: RefundPolicy = {
  firstPaymentRefundDays: 14,
  replyWorkingDays: 2,
  updated: "2026-11-01",
};

/** The policy as plain paragraphs, in reading order. */
export function refundPolicyParagraphs(
  p: RefundPolicy = refundPolicy,
): string[] {
  return [
    "You can cancel your subscription at any time from your billing page. Cancelling stops the next payment; you keep access until the end of the period you have already paid for.",
    "If you start with a free trial, you are not charged until the trial ends. Cancel before then and you pay nothing.",
    `If you ask within ${p.firstPaymentRefundDays} days of your first payment, we refund that payment in full, no questions asked.`,
    "After that, we do not refund part of a period you have already started, except where we charged you by mistake — a payment taken twice, or a payment taken after you cancelled — which we always refund in full.",
    `To ask for a refund, contact us from the email address on your account. We reply within ${p.replyWorkingDays} working days. A refund goes back to the card you paid with and usually arrives within 5 to 10 working days.`,
    "If something is wrong with a charge, please contact us before disputing it with your bank: we can usually put it right the same day.",
  ];
}
