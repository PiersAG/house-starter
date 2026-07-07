# Breach procedure

STUB — replace before requesting LIVE-OPEN

Replace this scaffold with an app-specific breach procedure. The gate checks existence + length + required heading; the CEO judges adequacy.

## Breach procedure

A personal-data breach is any confidentiality, integrity, or availability failure that affects personal data. Under UK/EU GDPR, notifiable breaches require notice to the supervisory authority within 72 hours of awareness.

### Detection

Name the signals that would surface a breach (uptime alerting, error monitoring, unauthorised-access alerts, user reports). Point to the dashboards and alert channels that fire.

### Containment

The first response is containment: revoke tokens, rotate secrets, isolate the affected service. Name who does this (on-call role) and how (which runbook / command).

### Assessment

Within 24 hours of awareness, record:

- What happened (facts, not narrative).
- What personal data was affected: which categories, how many data subjects, approximate volume.
- What is the risk to data subjects (severity: confidentiality vs integrity vs availability; consequences: identity theft, financial loss, reputational harm, discrimination).
- Was the data encrypted? Was any of it pseudonymised in a way that makes re-identification difficult?

### Notification thresholds

- **Supervisory authority**: notify within 72 hours if the breach is likely to result in a risk to rights and freedoms. Under most modern regimes, that is a low bar — err on notifying.
- **Data subjects**: notify without undue delay if the breach is likely to result in a high risk (identity theft, financial loss).

Record the notification templates (both) and the channel used.

### Internal log

Every breach — notifiable or not — is logged. Name the log location, and what is recorded per breach: id, first-awareness timestamp, containment timestamp, assessment summary, notification decisions and timestamps, action items.

### Post-incident review

Every breach gets a post-mortem. Record the venue (weekly review, ad-hoc meeting) and the outputs (root cause, prevention actions, owners, deadlines).

### Review

Review this procedure annually and after every breach.
