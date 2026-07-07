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

- **Access**: how the personal data is exported (which fields, which format) and how it is delivered.
- **Rectification**: which fields are self-serve in the app; which require a support action.
- **Erasure**: is deletion "hard" (row removed) or "soft" (row anonymised)? What data is retained under a lawful basis to override erasure (billing records, unresolved disputes)?
- **Restriction**: how processing is paused without deletion.
- **Portability**: which fields are portable and in what format (CSV, JSON).
- **Objection**: which purposes accept an objection (marketing always does; legitimate-interest ones assess the balance).

### Logging

Every SAR must be logged. Name the log location and what is recorded per request (id, date received, date responded, action taken, staff member).

### Escalation

State when a SAR triggers an incident (e.g. an erasure that surfaces uncontrolled personal data elsewhere). Point to `breach-procedure.md` for the incident path.

### Review

Review this procedure annually.
