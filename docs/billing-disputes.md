# When a customer disputes a charge (chargeback)

PiersAG/app-business-core#370. A dispute is the customer asking their bank to
take a payment back. Stripe holds the money (and a dispute fee) until the bank
decides. The app records every dispute in `billing_disputes` and emails the
app's owner (`OWNER_EMAIL`) when one opens, with the amount, the reason and the
**deadline for evidence**. After the deadline the dispute is lost automatically.

## 1. Decide: send evidence or accept (the same day)

Open the dispute in Stripe (Payments → Disputes; the email names its id).

- **Accept** when the customer is right: a charge after they cancelled, a
  payment taken twice, or a service they did not get. Accepting ends it; the
  money stays with the customer. Fix the cause.
- **Send evidence** when the charge was proper and the service was delivered.

## 2. The evidence pack

Everything below is in the app or in Stripe; nothing has to be collected by hand.

- The customer's account email and sign-up date.
- The subscription and its invoices: `billing_invoices` holds every invoice the
  app was told about — amount, when it was paid, the Stripe invoice link, and
  the receipt the app emailed (`receipt_sent_at`).
- That the customer agreed to the price and the refund policy: the payment page
  showed the refund policy (`/refund-policy`) above the pay button.
- That they used the service: their last sign-ins and the records they created.
- Any messages with them (support inbox).
- Refund policy text (`config/refund-policy.ts`) and when it was last changed.

Attach these in Stripe's dispute form under the reason the bank gave, and submit
before the deadline.

## 3. While the dispute is open

The customer keeps their access. A dispute alone does not cut anyone off: many
are raised by mistake and withdrawn, and cutting access would make a "service
not provided" dispute true. If the customer's subscription payment later fails,
the normal failed-payment steps apply.

## 4. The outcome

When the bank decides, Stripe sends `charge.dispute.closed`, and the app records
the result (`won`, `lost`) and the date in `billing_disputes`. A lost dispute
costs the payment and the fee; look at why before it repeats.

## 5. Watch the rate

Each alert says how many disputes opened in the last 90 days against how many
invoices were paid. Card networks start monitoring an account at about 0.75%;
the alert says so when the rate is at or above it. At that point, find the
common cause (unclear descriptor on card statements, charges after
cancellation, a trial that converts without a reminder) and fix it.
