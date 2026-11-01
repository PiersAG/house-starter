# Security questionnaire — ready answers

PiersAG/app-business-core#524 (Matt Murphy #151): buyers check security before
they sign. This sheet answers the questions a security questionnaire asks, for
every app built from this template. Copy it into the app's reply; fill the
three per-app lines from `config/security-profile.ts`. Each answer names where
it is true in the code, so a reviewer can check it.

The same facts are on the app's public page at `/security`, and outsiders
report a flaw through `/.well-known/security.txt`.

| Question | Answer | Where it is true |
|---|---|---|
| Is data encrypted in transit? | Yes. HTTPS only; HTTP Strict Transport Security for two years, sub-domains included, on every response. | `next.config.ts` (headers), `tests/e2e/security-headers.spec.ts` |
| How are passwords stored? | Never in readable form: a bcrypt hash only. | `lib/password.ts` |
| Is multi-factor sign-in available? | Yes, authenticator-app codes with recovery codes; the secrets are stored encrypted. | `lib/mfa/`, `lib/crypto/` |
| Are sessions protected? | Signed session cookies (HttpOnly, Secure, SameSite=Lax), renewed every ten minutes with the role re-read; a new session id at sign-in and at a role change; sign out of all devices. | `auth.config.ts`, `lib/account-security.ts` |
| How is one customer's data kept from another's? | A database per customer business by default (`TENANCY_MODE`); every change runs a test that signs in as one business and tries to read and change another's data. | `lib/db.ts`, `tests/isolation/per-tenant.spec.ts` |
| Is input validated? | Every API route that reads a request body checks it against a schema first; the build's scan fails a route that does not. | `app/api/**`, the factory's input-validation rule |
| Do you scan for vulnerabilities? | On every change: every package in the lockfile is audited (known flaws, new maintainers, install scripts), the code is scanned for security mistakes and leaked keys, and the running app is scanned. | `.github/workflows/ci.yml`, `scripts/check-deps-existence.py`, the app's security-scan workflow |
| Which browser protections are set? | A nonce-based content security policy with violation reporting, no framing by other sites, no MIME sniffing, a strict referrer policy and a locked-down permissions policy. | `lib/csp.ts`, `next.config.ts` |
| Can other websites call the API with a user's cookies? | No. Only the app's own origin and the origins hard-coded in `config/cors.ts` (none by default); every other origin gets no CORS header and a refused preflight. | `lib/cors.ts`, `tests/e2e/cors.spec.ts` |
| Are sign-in attempts limited? | Yes, per client address on every sign-in surface, and per account for second-factor codes; password-reset links last 15 minutes, at most 3 per account per hour. | `lib/auth-rate-limit.ts`, `lib/password-reset.ts` |
| How are secrets and keys held? | Never in code; read through one key layer, each module allowed only the keys it needs. | `lib/vault.ts`, `lib/key-access.json` |
| What happens in a breach? | A written procedure: contain, assess, tell affected customers without undue delay, and the regulator within 72 hours where the law requires. | `docs/legal/breach-procedure.md` |
| How do we report a security problem? | Through the contact in `/.well-known/security.txt` and the "Report a security problem" section of `/security`. | `app/.well-known/security.txt/route.ts`, `app/security/page.tsx` |
| Where is data stored? | *Per app:* `SECURITY_PROFILE.dataLocation`. | `config/security-profile.ts` |
| How is data backed up? | *Per app:* `SECURITY_PROFILE.backups`. | `config/security-profile.ts` |
| Who is the security contact? | *Per app:* `SECURITY_PROFILE.contactEmail`, else `SECURITY_CONTACT_EMAIL`, else the support address. | `config/security-profile.ts` |
| How long is personal data kept? | As the app's retention policy states. | `docs/legal/retention-policy.md` |
