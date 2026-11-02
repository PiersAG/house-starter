# Subject Access Request (SAR) procedure

STUB — replace before requesting LIVE-OPEN

Replace this scaffold with an app-specific SAR procedure before requesting LIVE-OPEN. The gate checks existence, length, and heading; adequacy is the CEO's call.

## SAR procedure

A data subject may request: access to their personal data, rectification of inaccurate data, erasure ("right to be forgotten"), restriction of processing, portability, and objection to processing. This procedure records how the app handles each.

### Contact route

Name the email (or in-app route) a data subject uses to lodge a SAR. Include an alternative in case the primary route is unavailable.

### Response SLA

Under UK/EU GDPR the response window is one month, extendable by two further months for complex requests. Record the SLA the app commits to (typically 30 days) and how the extension is handled.

### Verification

Name the identity-verification step (typically: the request must come from the email tied to the account, and the app confirms via a challenge to that email). Record what happens if verification fails.

### The mechanism

For each right, name the concrete steps:

- **Access**: self-serve. Signed in, Account → Your data → **Download my data** returns one JSON file with every row the app holds on the account, its own database included, built from `config/personal-data.ts` (`lib/privacy/data-report.ts`); secrets are never included and internal ids are named as held. For a request made outside the app, the operator signs in as nobody: verify the requester (below), then produce the same report with `buildDataReport` and send it to the account's address.
- **Rectification**: which fields are self-serve in the app; which require a support action.
- **Erasure**: self-serve. Account → Your data → **Delete my account** closes the account at once (sign-in refused, sessions ended) and erases it 30 days later through the daily retention job (`lib/privacy/retention-job.ts`): rows are deleted or anonymised table by table as `config/personal-data.ts` says, invoices and payment disputes keep only their amounts and dates for 6 years in the retention layer, the account's own database is wiped and removed, the erasure is checked and the owner is emailed (`docs/legal/retention-policy.md`).
- **Restriction**: how processing is paused without deletion.
- **Portability**: the same JSON file as Access.
- **Objection**: which purposes accept an objection (marketing always does; legitimate-interest ones assess the balance).

### Logging

Every SAR must be logged. Name the log location and what is recorded per request (id, date received, date responded, action taken, staff member).

### Escalation

State when a SAR triggers an incident (e.g. an erasure that surfaces uncontrolled personal data elsewhere). Point to `breach-procedure.md` for the incident path.

### Review

Review this procedure annually.
