# Data protection — what leaves the server, and how

Bundle S10 (app-business-core issues #445, #794, #763, #797, #353, #785, #807).
Every app built from this template inherits all of it. Each rule names the file
that does the work and the test that fails when it is broken.

## 1. Every column has a class

`config/data-classification.ts` lists every column of every table in
`lib/schema.ts` as **public**, **personal** (the account's own data),
**internal** (server bookkeeping) or **secret** (credential material).

- A new column fails `tests/unit/data-classification.test.ts` until it is listed.
- A secret column names the file that writes it, and the test checks that file
  hashes it (bcrypt for passwords, SHA-256 for reset tokens and recovery codes) or
  seals it (AES-256-GCM, `lib/crypto/secret-box.ts`, for authenticator secrets and
  tenant database tokens).

## 2. The browser gets DTOs, not rows

Everything a server component passes to a `"use client"` component, every route
answer and every server-action return is sent to the browser. So:

- pages and routes name the columns they read (`db.select({ … })`, `columns: { … }`);
- each boundary has a DTO — `defineDto({ … })`, `X.from(row)`, `dtoJson(X, row)` in
  `lib/dto.ts` — which keeps the named fields and drops every other one;
- nothing internal or secret, and no whole row, crosses.

Held by `tests/unit/data-boundary.test.ts` (the TypeScript checker reads every
answer, action return and client prop, and seeded leaks prove it catches each
shape) and `tests/e2e/payload-audit.spec.ts` (signed in, it fetches every page —
its HTML and its React Server Components payload, the `RSC: 1` wire format — and
every read route, and fails on an internal or secret field, a password hash or a
secret value).

## 3. Nothing signed-in is cached

`dtoJson` answers `Cache-Control: no-store`. The payload audit fails any answer
that needs a session, or carries the account's own data, without `no-store` or
`private`. The factory gate fails `public`, `s-maxage`, `revalidate` or
`force-static` under `/api`.

## 4. Server code and secrets stay out of the bundle

- `server-only` is installed; every module under `lib/`, `config/` and
  `components/` that touches the database, a key or a credential starts with
  `import "server-only"`, so Next.js fails the build if a client component reaches
  it. Node-run tooling (the tsx scripts, Playwright, drizzle-kit) loads
  `scripts/server-only-node.cjs` first; vitest aliases the package's empty half.
- `tests/unit/server-boundary.test.ts` walks every client entry point's imports
  and fails a chain that reaches server code; a client file reads no server
  variable; server actions live in their own `"use server"` files.
- `config/public-env.ts` lists every `NEXT_PUBLIC_` variable with its reason;
  `tests/unit/public-env.test.ts` fails an unlisted or secret-named one, and a
  key-shaped value anywhere in the source.
- The factory's planted gate builds the app with throwaway values and searches
  every browser file for those values, database hosts, connection strings, keys,
  server variable names and internal endpoints (dast job, "Scan the built
  browser output").

## 5. Writes need the page's request token

`lib/csrf.ts`: a POST, PUT, PATCH or DELETE route calls `verifyCsrf(request,
session)` (signed out: `verifySameOrigin(request)`). Another website's request is
refused by its Origin; a signed-in write also needs `x-csrf-token`, an HMAC over
the user and session ids keyed from the sign-in secret, which the page passes to
its client component. The session cookie is SameSite=Lax as well. Server actions
get Next.js's own Origin check. `tests/unit/csrf.test.ts` lists every write
endpoint; `tests/e2e/csrf.spec.ts` attacks each one from a foreign origin.
Not yet covered, with the owner: the billing checkout and portal routes (next
payments dispatch; `tests/unit/csrf-routes.ts`).

## 6. In transit and at rest

- **In transit:** Vercel serves HTTPS only (platform-covered); the factory's dast
  job checks `Strict-Transport-Security` on the served app (SEC.29).
- **Payload fields:** for a payload to a native mobile app or another system,
  `sealFields()` / `openFields()` (`lib/crypto/field-seal.ts`) seal named fields
  with a key the two ends share, so they stay protected even if the connection
  is not. A web page in the app's own tab gains nothing from it (it would have to
  hold the key), so the app's own pages rely on HTTPS and on DTOs.
- **At rest:** secrets are hashed or sealed by the app (section 1). Encryption of
  the database files themselves is the database provider's (Turso); recorded as
  platform-covered, to be confirmed against the provider's terms at launch (#445).

## 7. Storage and third parties

- No customer data — uploads, exports, backups, reports — in a public bucket:
  the factory gate fails public storage written from code and public buckets in
  Terraform; files are served through short-lived signed links.
- `config/third-party.ts` lists every external resource with what it can reach
  and the pages it loads on (empty today); scripts load only through
  `components/ThirdPartyScripts.tsx`, which refuses sign-in, account, dashboard
  and billing pages. `tests/unit/third-party.test.ts` keeps the list, the CSP
  sources (`config/csp.ts`) and the source in agreement.
