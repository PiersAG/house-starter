// Every payment path the app's checkout can offer, and how each is proven
// (PiersAG/app-business-core#780; Matt Murphy #146: "nobody asked it to test or
// verify the other payment method", and "a test suite that catches PayPal flow on
// the mobile layout").
//
// The checkout offers ONLY the methods in config/billing.ts `paymentMethods`
// (passed to Stripe as payment_method_types), so a method Stripe adds to the
// account's dashboard is never offered untested. Each offered method must have an
// entry here for both device classes; tests/unit/payment-methods.test.ts fails when
// one is missing, so adding a method (PayPal, a wallet) cannot ship without its
// path being written down and run.

export type DeviceClass = "desktop" | "phone";

export interface PaymentPath {
  /** The Stripe Checkout payment method type. */
  method: string;
  /** What is run on each device class, and where its result is recorded. */
  devices: Record<DeviceClass, string>;
}

export const PAYMENT_PATHS: PaymentPath[] = [
  {
    method: "card",
    devices: {
      desktop:
        "Stripe test mode: subscribe from the plan card, pay on Stripe's payment page with card 4242 4242 4242 4242, a 3-D Secure card (4000 0027 6000 3184) and a declined card (4000 0000 0000 0002); the webhook marks the invoice paid, or records the failure and sends the failed-payment email. Run on the app's preview at the K9Coach rebuild (#780 tick-list).",
      phone:
        "The same three cards on a phone-sized browser (390 × 844) and on a real phone, in test mode: the plan card and Subscribe button fit the screen, Stripe's page opens, and the return lands on the dashboard. Run on the app's preview at the K9Coach rebuild (#780 tick-list).",
    },
  },
];
