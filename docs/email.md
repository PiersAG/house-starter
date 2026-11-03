# Email: sending, the sending domain and delivery monitoring

app-business-core issues 470 and 757. What the template does, the settings, and
the one-time steps a person does for each app before it sends real mail.

## What the template does

- `sendEmail(to, template, data)` (`lib/email/send.ts`) is the one way the app
  sends mail: password resets, receipts, account notices.
- `EMAIL_SEND_MODE=log` (the default; CI and previews) writes a line and sends
  nothing. `EMAIL_SEND_MODE=live` sends through the provider `EMAIL_PROVIDER`
  names (`lib/email/provider.ts`; `resend` when unset).
- In live mode a message goes out only from the **transactional sending
  domain**: a subdomain kept for these emails alone (for example
  `mail.getk9coach.com`), never the bare domain marketing mail would use
  (`lib/email/sending-domain.ts`). Matt Murphy #131: "step 2A dedicated sending
  domain for transactional e-mail separate from your marketing".
- The provider posts a signed report for every message (sent, delivered,
  bounced, marked as spam) to `/api/email/events`. The app keeps the type and
  the provider's message id only — never an address, subject or body — for 90
  days (`lib/email/delivery.ts`).
- `/api/health` has an `email` check (live mode only). It is red, and the app
  answers 503 so the outside uptime check raises the alert, when:
  - the sending domain setting is wrong;
  - the delivery reports are not set up (`EMAIL_EVENTS_SECRET` missing);
  - the spam-complaint rate over 30 days is 0.1% or more (Gmail asks senders to
    stay under 0.1% and never reach 0.3%);
  - the bounce rate over 30 days is 4% or more, once 50 messages have gone.

## Settings

| Name | What it is |
|---|---|
| `EMAIL_SEND_MODE` | `live` in production only. |
| `EMAIL_PROVIDER` | `resend` (the only provider wired today). |
| `EMAIL_PROVIDER_API_KEY` | The provider's sending key (a secret). |
| `EMAIL_SENDING_DOMAIN` | The transactional subdomain, e.g. `mail.getk9coach.com`. |
| `EMAIL_FROM` | The sender, e.g. `K9Coach <hello@mail.getk9coach.com>`; must use the sending domain. |
| `EMAIL_MARKETING_DOMAIN` | Optional: the domain marketing mail uses; must not be the sending domain. |
| `EMAIL_EVENTS_SECRET` | The signing secret the provider shows for the delivery-report webhook (a secret). |

## One-time steps for each app (a person does these)

1. **Provider account.** Create the account, with its data region set to the EU
   (Resend: Ireland, `eu-west-1`) — the region is chosen when the domain is
   added and cannot be changed afterwards.
2. **Add the sending domain** at the provider: the subdomain, not the bare
   domain (e.g. `mail.getk9coach.com`).
3. **DNS records** at the domain's DNS host, exactly as the provider shows them:
   - SPF (a TXT record, and an MX record for bounces, on the provider's
     sub-name);
   - DKIM (a TXT record on the provider's `_domainkey` name);
   - DMARC: a TXT record at `_dmarc.<bare domain>`, starting with
     `v=DMARC1; p=none; rua=mailto:<an inbox you read>` — move to `p=quarantine`
     after a month of clean reports.
4. **Check the records:** with the key and `EMAIL_SENDING_DOMAIN` set,
   `npm run email:domain-status` prints each record's state and ends `READY`
   when SPF, DKIM and DMARC are all in place.
5. **Delivery reports:** add a webhook at the provider to
   `https://<production address>/api/email/events` for these events: sent,
   delivered, delivery delayed, bounced, complained, failed, suppressed. Store
   the signing secret it shows as `EMAIL_EVENTS_SECRET`.
6. **Production settings:** `EMAIL_SEND_MODE=live`, `EMAIL_PROVIDER`,
   `EMAIL_PROVIDER_API_KEY`, `EMAIL_SENDING_DOMAIN`, `EMAIL_FROM` and
   `EMAIL_EVENTS_SECRET` on the production deployment.
7. **Prove it end to end:** request a password reset for a real inbox you own,
   receive it, follow the link and sign in with the new password. Then check
   `/api/health` shows `email` green.
8. **Inbox placement** — whether mail lands in the inbox or the spam folder,
   which no provider report shows. Matt Murphy #131: "you need to know your inbox
   placement rate and your spam complaint rate before your customers tell you
   about it".
   - Register the sending domain (free) at Google Postmaster Tools,
     https://postmaster.google.com — Gmail's spam rate and the domain's
     reputation. Gmail shows figures once a domain sends enough mail to Gmail
     each day.
   - For Outlook and Hotmail there is no free domain-level report for mail sent
     from a provider's shared addresses (Microsoft SNDS reports on sending IP
     addresses the sender owns). Keep one Outlook.com and one Gmail inbox of your
     own and send a password reset to each: inbox or junk folder is the reading.

   Look once a week until the volume is steady, then once a month.
