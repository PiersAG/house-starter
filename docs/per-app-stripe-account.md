# Per-app Stripe account (stripe-per-app-accounts)

Every factory app is **its own Stripe merchant** — its own business name on
Checkout, receipts, notifications and the card statement. That is achieved by
each app having its **own Stripe account** (a distinct `STRIPE_SECRET_KEY`), not
by template code: `lib/billing/stripe.ts` reads `STRIPE_SECRET_KEY` from the env
and the webhook route reads `STRIPE_WEBHOOK_SECRET`, so distinct per-app values
just work. Payouts across apps consolidate to one business bank account where
the account holder is the same legal entity.

## What the code does
- Tags the **checkout session** and the **subscription** it creates with
  `metadata.app_id = billingConfig.appId` (`app/api/billing/checkout/route.ts`).
- `config/billing.ts` carries `appId` and an optional `statementDescriptor`, set
  by the per-app build phase alongside the real `priceIds`.
- Shows the refund policy (`/refund-policy`, words in `config/refund-policy.ts`)
  on the payment page, above the pay button.
- Handles each webhook event once, even when Stripe sends it twice at the same
  time (`lib/billing/webhook.ts`).
- After a successful charge: records the invoice as paid, makes the
  subscription active and sends the customer a receipt. After a failed charge:
  one email per payment attempt, three at most. When a customer disputes a
  charge: records it and emails the app's owner (`OWNER_EMAIL`) the deadline.
- In production, refuses a full-power secret key (`sk_…`): billing runs only on
  a restricted key (step 4).

## What is MANUAL, per app, in that app's own Stripe account (TEST mode for now)
1. **Create the app's own Stripe account** (separate from the shared factory
   account). Set the **business/account name** — this is what shows on Checkout,
   receipts and the statement.
2. **Product + price:** create the product and recurring price. Set the
   product's **`statement_descriptor`** and add **`metadata.app_id = <slug>`** on
   the price. Put the new **price id** into `config/billing.ts` `priceIds.default`.
3. **Webhook endpoint:** add an endpoint at `https://<app-url>/api/billing/webhook`
   for these events, and copy its **signing secret**:
   - `checkout.session.completed`
   - `customer.subscription.updated`, `customer.subscription.deleted`
   - `invoice.paid`, `invoice.payment_failed`
   - `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`,
     `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`
4. **Restricted key** (Developers → API keys → Create restricted key). Name it
   after the app. Grant exactly these permissions and leave every other one at
   None — the list is `lib/billing/permissions.ts`, and a test fails the build
   when this table and the code disagree:

   | Permission | Access |
   |---|---|
   | Checkout Sessions | Write |
   | Customer portal | Write |

   Use this restricted key (`rk_…`) as the app's billing key. Production refuses
   a full-power secret key (`sk_…`) with a plain message saying so. Make the
   first test checkout with it: if Stripe answers that a permission is missing,
   add that one permission and record it in `lib/billing/permissions.ts`.
5. **App repo secrets** (make the values DISTINCT to this account):
   - `STRIPE_TEST_SECRET_KEY` → this account's **test** key.
   - `STRIPE_WEBHOOK_SECRET` → the endpoint's signing secret from step 3.
6. **Automatic retries of failed payments** (Settings → Billing → Revenue
   recovery → Retries): turn on **Smart Retries** and set the retry window to
   **2 weeks** (within the 7–14 days a failed payment should be fought for), and
   set what happens after the last retry to **mark the subscription as unpaid**
   (the customer's data is kept). The app sends its own three failed-payment
   emails, so leave Stripe's own "failed payment" customer emails **off**, or the
   customer gets two of each. If retries are off, the app writes a
   "retries look switched off" line to its error log on the first failure.
7. **Receipts:** the app sends its own receipt after every successful charge, with
   a link to Stripe's invoice page, so leave Stripe's "successful payments"
   customer emails **off**.
8. **Customer metadata:** customers are created by Checkout inside this account,
   so they already belong to the app; tag `metadata.app_id` on the product/price
   (step 2) for cross-reference. (The subscription is tagged by code.)

## The price: the brief's, or a marked placeholder (app-business-core #374)

CEO ruling 2026-11-03: the build uses the price in the brief automatically. If the
brief has no price (or one that cannot be read exactly), the build uses a **£20/month
placeholder, clearly marked as one**, and is never blocked for want of a price.

- Provisioning stamps `pricePlaceholder: true` into `config/billing.ts` and tags the
  Stripe price `metadata.placeholder = true` (nickname "PLACEHOLDER price").
- While it is set, the app refuses a **live** Stripe key (`lib/billing/placeholder.ts`):
  test mode and previews work as usual; no real payment can be taken on a placeholder.
- CI (`scripts/check-billing-configured.mjs`) warns; it does not fail.
- The factory's launch checklist (`agents/launch_checklist.py`, #347) refuses launch.

**Changing the price** (setting the real one before launch, or any later change):

1. In app-business-core: `python3 scripts/set_app_price.py --build <build_id> --price "£29/month"`
   (`--dry-run` first to see the change). It records the new price with
   `placeholder: false` and raises `price_version`; merge it through a pull request.
2. Run the app's billing provisioning (`provision-app-billing.yml` with the build id).
   The raised version lets it create the new test price under the app's lookup key. The
   old price is left active, because this app keeps sending its id until the pull request
   stamping the new one merges, and Stripe refuses an archived price at checkout (Stripe
   prices never change once made; existing subscribers keep the price they signed up on).
   It opens a pull request here stamping the new price id with `pricePlaceholder: false`.
3. Live mode: at the live switch-over (#469) the live price is created at the amount
   recorded in step 1, and its id is stamped by pull request.

Tiers and free plans can be added later. Individual accounts can be made free by the
owner with the existing grants (owner, tester, comp — `scripts/grant-access.ts`).

## LIVE mode / activation (DEFERRED — needs the business bank account)
- Complete **activation / KYC** and connect the **business bank account** (same
  legal entity, for consolidated payouts). Then create the live product/price,
  repeat steps 3, 4, 6 and 7 in live mode (the restricted key is created again,
  live), and swap in the live keys. Not done now — **test mode only** until the
  bank account exists.
