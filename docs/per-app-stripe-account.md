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

## What is MANUAL, per app, in that app's own Stripe account (TEST mode for now)
1. **Create the app's own Stripe account** (separate from the shared factory
   account). Set the **business/account name** — this is what shows on Checkout,
   receipts and the statement.
2. **Product + price:** create the product and recurring price. Set the
   product's **`statement_descriptor`** and add **`metadata.app_id = <slug>`** on
   the price. Put the new **price id** into `config/billing.ts` `priceIds.default`.
3. **Webhook endpoint:** add an endpoint at `https://<app-url>/api/billing/webhook`
   for the subscription + invoice events; copy its **signing secret**.
4. **App repo secrets** (make the values DISTINCT to this account):
   - `STRIPE_TEST_SECRET_KEY` → this account's **test** secret key.
   - `STRIPE_WEBHOOK_SECRET` → the endpoint's signing secret from step 3.
5. **Customer metadata:** customers are created by Checkout inside this account,
   so they already belong to the app; tag `metadata.app_id` on the product/price
   (step 2) for cross-reference. (The subscription is tagged by code.)

## LIVE mode / activation (DEFERRED — needs the business bank account)
- Complete **activation / KYC** and connect the **business bank account** (same
  legal entity, for consolidated payouts). Then create the live product/price and
  swap in the live keys. Not done now — **test mode only** until the bank account
  exists.
