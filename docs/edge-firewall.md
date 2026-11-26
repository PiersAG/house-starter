# Edge firewall

The edge firewall stops hostile requests before they reach the app (app-business-core #511, #754 and #755). Which provider applies the rules is the CEO's decision on #702 — Vercel's own firewall (2026-11-02). The decision is a single setting, `EDGE_FIREWALL_PROVIDER` in `config/edge-firewall.ts`. The rules are the same whichever provider applies them.

## Applying the decision

The CEO chose Vercel's own firewall on 2026-11-02 (#702), so `EDGE_FIREWALL_PROVIDER` is `"vercel"`.

1. The rules are written once, in `config/edge-firewall.ts`. `config/edge-firewall-vercel.ts` translates them for Vercel and `npm run edge:firewall:config` writes the result to `config/edge-firewall.vercel.json`. Never edit the JSON by hand: `tests/unit/edge-firewall-vercel.test.ts` fails while it and the TS file disagree.
2. The factory applies the JSON to the app's production Vercel project with OpenTofu (`app-business-core` `infra/edge-firewall/`, run by `agents/edge_firewall.py`). Each run first imports the project's live firewall configuration, then plans, then applies — Vercel replaces the whole configuration on every apply, so the managed rule sets are declared in the JSON too.
3. The set needs 8 custom rules, 2 of them rate limits (`needs` in the JSON). Vercel's Hobby plan allows 3 custom rules and 1 rate-limit rule per project, so the set does not fit Hobby; Pro (40 custom rules) holds it whole. The factory refuses to apply it to a project on a plan where `fits` is false — it never applies part of the set, and no rule is dropped or merged to make it fit.
4. Run `node scripts/edge-check.mjs https://<production address>`. It sends every attack in `config/edge-check-payloads.json` and expects each one refused, then sends ordinary requests and expects each one served. The first run on a real project also settles one translation detail marked as inferred in `config/edge-firewall-vercel.ts`: which Vercel condition matches the whole query string, and whether Vercel matches it decoded.
5. Every day the factory reads each app project's live firewall configuration back against the JSON (`agents/vercel_settings.py`); a difference opens an ALERT ticket.

## The rules

| Rule | What it stops | Vercel Firewall (custom rule) | Cloudflare (WAF custom rule) |
|---|---|---|---|
| `sqli` | SQL injection in the query string | Query matches the patterns in `EDGE_RULES` → Deny | Same expression on `http.request.uri.query` → Block |
| `xss` | Script injection in the query string | Query matches → Deny | `http.request.uri.query` → Block |
| `path-traversal` | `../`, `/etc/passwd`, `/.env`, `/.git/` | Path matches → Deny | `http.request.uri.path` → Block |
| `scanner-paths` | WordPress, phpMyAdmin and `.php`-style probes | Path matches → Deny | `http.request.uri.path` → Block |
| `bad-bots` | Known attack tools, by user agent | User agent matches → Deny | `http.user_agent` → Block |
| Sign-in rate limit | Floods on `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/api/auth/` | Rate-limit rule, per IP, 60 seconds: challenge above 20, deny above 60 | Rate-limiting rule, same paths and thresholds |
| Bot management | Automated traffic on `/signup`, `/login`, `/pricing`, `/api/auth/`, `/api/billing/checkout` | Custom rule on those paths → Challenge (Vercel's managed bot protection covers the whole project, so it stays off) | Bot Fight Mode, or a rule on the bot score → Managed Challenge |

The patterns are held in one place, `EDGE_RULES`. `tests/unit/edge-firewall.test.ts` proves two things: every attack in the payload list trips its rule, and ordinary requests do not. Examples of ordinary requests are a search for "O'Brien's dog training", a sign-in page and a search-engine crawler. The app runs the same rules on every rate-limited route (`docs/rate-limits.md`), so API routes are covered even with no provider.

Sign-in thresholds at the edge sit above the app's own sign-in limits, so the edge only acts on a flood. A person mistyping a password never meets it.

## When a proxy sits in front of the host (Cloudflare) — #755

With Vercel's own firewall nothing sits in front of the host, so there is no way round it and this section does not apply. With Cloudflare in front, all three of these are needed:

- **No way round it.** Check every subdomain, every MX record, every outgoing email header and DNS history services for the host's address. On Vercel the host address is the `*.vercel.app` deployment address, plus any custom domain not proxied through Cloudflare.
- **Accept only traffic that came through Cloudflare.** A Cloudflare Transform Rule adds a secret header (`ORIGIN_LOCK.header`, `x-origin-verify`) to every request it forwards. The host refuses any request without it. A Vercel Firewall custom rule (header does not equal the value → Deny) does this before the app runs. `originLockRefuses` in `config/edge-firewall.ts` is the same check in code, and it fails closed when the value is not configured. The secret's value is stored in the vault and never in the repo.
- **TLS end to end.** Set Cloudflare's SSL mode to Full (strict), so Cloudflare checks the host's certificate. Vercel serves a valid certificate for the custom domain, which takes the place of a Cloudflare origin certificate.
