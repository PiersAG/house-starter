# Record of Processing Activities (RoPA)

STUB — replace before requesting LIVE-OPEN

Replace this scaffold with the app-specific RoPA before requesting LIVE-OPEN. The gate checks existence, minimum length, and the required heading; the CEO judges adequacy of the content.

## Processing activities

A RoPA under UK/EU GDPR names, for each processing activity: the purpose, the categories of data subjects and personal data, the recipients (including third-country transfers), the retention regime, and a description of the technical and organisational safeguards. This file is the master record; the finer detail lives in the individual policies (`privacy-policy.md`, `lawful-basis.md`, `retention-policy.md`).

### Activity 1 — _[e.g. account authentication]_

- **Purpose:** _e.g. authenticate users so they can access the app._
- **Data subjects:** _e.g. registered users._
- **Categories of personal data:** _e.g. email address, hashed password, login timestamps._
- **Lawful basis:** contract (see `lawful-basis.md`).
- **Recipients:** _e.g. Vercel (application hosting), Supabase (database + auth backend)._
- **Third-country transfers:** _e.g. Supabase is EU-hosted; no transfer outside the UK/EEA._
- **Retention:** until account deletion + 30 days (see `retention-policy.md`).
- **Safeguards:** TLS in transit, encryption at rest, hashed passwords (Argon2 or equivalent), rate-limiting on login, session-token rotation.

### Activity 2 — _[e.g. usage analytics]_

- **Purpose:** _..._
- **Data subjects:** _..._
- **Categories of personal data:** _..._
- **Lawful basis:** _..._
- **Recipients:** _..._
- **Third-country transfers:** _..._
- **Retention:** _..._
- **Safeguards:** _..._

Repeat for every processing activity the app carries. A RoPA is a management artifact — one row per activity, updated when activities change.

### Change log

Record when this RoPA was last reviewed and when each activity's row was last touched.
