# Support reply: a refund request

PiersAG/app-business-core#354. The Supporter's reply when a customer asks for a
refund. The Supporter drafts from this; a person sends any reply that promises
money back. The policy itself is `config/refund-policy.ts`, shown at
`/refund-policy`.

## Decide which case it is

1. **Within 14 days of their first payment** — refund that payment in full.
2. **Charged by mistake** (taken twice, or taken after they cancelled) — refund
   the wrong charge in full, whenever they ask.
3. **Anything else** — no refund for a period already started; offer to cancel
   so the next payment is not taken, and say until when they keep access.

Refunds are made in Stripe (Payments → the charge → Refund). Note the refund in
the reply with the amount.

## Reply, case 1 or 2

> Hi {name},
>
> Thanks for getting in touch. I've refunded {amount} to the card you paid with.
> It usually reaches your account within 5 to 10 working days.
>
> {If they want to stop: I've also cancelled your subscription, so you won't be
> charged again.}
>
> If there's anything we could have done better, I'd like to hear it.

## Reply, case 3

> Hi {name},
>
> Thanks for getting in touch. Our refund policy ({app url}/refund-policy) gives a
> full refund within 14 days of the first payment; after that we don't refund
> part of a period that has started.
>
> I've cancelled your subscription, so you won't be charged again, and you keep
> full access until {end of paid period}.
>
> If something went wrong with the service, tell me what happened and I'll look
> into it.

## Never

- Promise a refund the policy does not give without the owner agreeing.
- Ask for card details by email.
- Tell the customer to dispute the charge with their bank.
