# House Starter

Next.js 15 App Router starter with CI green from commit zero and the universal quality baseline baked in.

## Before writing any code

1. Run `python agents/build-design.py --build <id>` to generate `DESIGN.md` and design tokens.
2. Copy the generated token values into `app/globals.css` (replace the defaults).
3. Read `BUILD-BRIEF.md` to understand what you're building.

## What's already in this template

These are universal — every app from this template has them from the first commit:

- **CI green from commit zero** — lint, TypeScript, Vitest (≥80% coverage), Playwright E2E, axe-core WCAG 2.2 AA, `npm audit` high/critical 0
- **Exact dependency versions + committed lockfile** — no version drift, no deploy-without-lockfile failures
- **Vercel deploy config** — `vercel.json` with `npm ci` install command
- **OWASP security headers** — HSTS, CSP, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, X-Frame-Options
- **Auth scaffold** — server-action pattern; no `next-auth/react` import (avoids the session-provider crash pattern); edge-safe `auth.config.ts` + full `lib/auth.ts` split; JWT session with correct expiry control
- **WCAG 2.2 AA compliant default tokens** — all contrast ratios verified; replace with app tokens before any UI
- **Reusable UI patterns** — `EmptyState`, `LoadingSpinner`, reactive error clearing in forms
- **Accessible form scaffold** — login page with labels, `aria-describedby`, focus rings, password toggle, remember-me

## Extension points (added per app, not in template)

These are conditional — do not add until the app needs them:

| What | Where to add | Why not in template |
|---|---|---|
| Payment / Stripe | `app/api/stripe/`, `lib/stripe.ts` | Only apps that take money |
| Role tiers (Admin / Member) | `lib/auth.ts` → extend `authorize()` | Only multi-role apps |
| Terms, Privacy, Cookie pages | `app/privacy/`, `app/terms/` | Legal profile varies by app |
| Signup page | `app/signup/` | Schema and validation are app-specific |
| Protected route patterns | `auth.config.ts` → `authorized()` callback | Routes are app-specific |
| DB schema | `lib/schema.ts` + `TENANT_MIGRATION_SQL` in `lib/migrate.ts` | Domain tables are app-specific |
| Error tracking (Sentry) | `sentry.config.ts`, `app/global-error.tsx` | Configured at MVP boundary |

### Tenancy: two databases, one seam (ADR-023)

The factory default is `per_tenant`. An app then runs on:

- **one catalog database** — `CATALOG_DATABASE_URL`, falling back to
  `DATABASE_URL`. Accounts, sessions, billing, the settings registry, and the
  `tenants` routing table. Login authenticates here, which is what lets a
  per-tenant app resolve a tenant from a credential.
- **one data database per tenant** — created at sign-up, its URL held in
  `tenants`. Holds only that customer's rows.

Writing app code against it:

```ts
// A page, server action or route handler — the tenant comes from the session.
import { getTenantDb } from "@/lib/tenant-context";

const db = await getTenantDb();
const rows = await db.select().from(dogs).all();
```

There is no `where tenantId = …` to remember: another customer's rows are not
filtered out, they are not in the database being queried. Control-plane reads
(accounts, subscriptions, settings) use `catalogDb` from `@/lib/catalog`
instead. The bare `db` export in `lib/db.ts` is a tripwire — it throws in
per-tenant mode and nothing should import it.

New domain tables go in `lib/schema.ts` and their DDL in
`TENANT_MIGRATION_SQL` (`lib/migrate.ts`), which is what the provisioner applies
to each new tenant database and what the fan-out below applies to existing ones.

Provisioning is by environment: one libSQL file per tenant under
`TENANT_DB_DIR` locally and in CI, and a real Turso database per tenant in any
deployed environment. A deployed app never silently falls back to files — see
`lib/tenant/provisioner.ts`.

### Tenant migration fan-out (per-tenant apps only)

After a schema change lands, the tenancy migration fan-out applies the new schema
across every tenant database in one run. The app's own catalog is the source of
truth for which tenants exist — the same registry `getDb(tenantId)` routes
through — so file-provisioned and Turso-provisioned tenants are both covered.
Operator runbook:

```bash
# One-time per environment: point at the app's catalog
export CATALOG_DATABASE_URL=...        # or rely on DATABASE_URL
export CATALOG_DATABASE_AUTH_TOKEN=... # for a remote catalog

# Dry-run to preview targets (no writes)
npm run db:migrate:all-tenants -- --dry-run

# Apply migrations to every tenant DB (per-DB failures isolated; report written)
npm run db:migrate:all-tenants

# Re-run a single failed tenant (idempotent — safe)
npm run db:migrate:all-tenants -- --tenant <tenant_id>

# Verify every tenant has point-in-time restore enabled (Stage 0 backup gate).
# This one talks to the Turso platform API directly (PITR is a Turso concept),
# so it still needs TURSO_API_TOKEN / TURSO_ORG / APP_SLUG.
npm run db:verify-tenant-backups
```

Refuses to run when `TENANCY_MODE=shared` — shared apps have one database and use
`npm run db:migrate` (drizzle-kit). Reports are written to
`migration-report-<timestamp>.json` and `pitr-report-<timestamp>.json` in the
current working directory. Spec: `wiki/specs/tenancy-migration-fanout.md` in
app-business-core; ADR-023 records the model. Tenant databases are still NAMED
`<app-slug>-<tenant-id>` in Turso, which is how `db:verify-tenant-backups`
enumerates them.

## Stack

- Next.js 15 (App Router, TypeScript strict)
- Tailwind CSS v3 with token-driven colour system
- NextAuth v5 (credentials, JWT, server-action pattern)
- Drizzle ORM
- Vitest + Playwright + axe-core

## Getting started

```bash
cp .env.example .env.local
# Fill in AUTH_SECRET (generate with: openssl rand -base64 32)
# Fill in DATABASE_URL
npm install
npm run prepare   # installs git hooks — see note below
npm run dev
```

**Why the extra `npm run prepare` step.** `.npmrc` sets `ignore-scripts=true`, so
npm does not execute lifecycle scripts — the control that stops a compromised
dependency running code at install time, before anyone has read it. npm applies
that to this project's own scripts too, so `npm install` no longer runs our
`prepare` (husky) automatically. `npm run <name>` still executes its named
script under `ignore-scripts`, so `npm run prepare` remains the supported way to
install git hooks. The hooks are not disabled; they just need one explicit
command after a clone.

## Responsive design (universal)

Every page and component must render correctly across the full breakpoint contract. These are the gated widths — new UI is expected to work at all of them:

| Name | Width | Notes |
|---|---|---|
| small phone | 320px | The floor. Where layouts actually break. |
| phone | 390px | Modern default (touch profile). |
| tablet | 768px | The forgotten middle case. Must be explicitly checked, not inferred. |
| laptop | 1280px | |
| desktop | 1920px | The ceiling. Content must not sprawl. |

**Rules that apply to every UI file:**
- **No horizontal overflow at any width.** `document.documentElement.scrollWidth <= window.innerWidth` for every page, at every viewport.
- **Touch targets** meet WCAG 2.5.8: 24×24 CSS px absolute minimum; use 44×44 (Tailwind `min-h-11 min-w-11`) for anything a finger will tap.
- **Breakpoint-aware spacing**, not fixed padding. Use `p-4 sm:p-6 lg:p-8`, not `p-12` alone. Existing pages (`app/login`, `app/signup`, `app/dashboard`, `app/contact`) are the reference.
- **Content max-widths** cap sprawl at 1920px+. Use `max-w-sm`, `max-w-xl`, `max-w-2xl` on `<main>`.
- **Fixed-width overlays are dangerous.** A `fixed w-80` element with right/left anchoring overflows at 320px. Use `inset-x-4 sm:w-80` or equivalent. See `components/support/SupportWidget.tsx` for the pattern.

**Advisory gate:** `npm run test:responsive` runs the E2E suite at all five widths with axe-core, no-horizontal-overflow, and touch-target checks. It ships **advisory** — failures are reported but do not fail the build, and **CI does not run it**. Flip to blocking with `RESPONSIVE_GATE=blocking npm run test:responsive`.

**Blocking gate:** `npm run test:layout` — the layout guardrail. Two checks on `/dashboard` and `/account` at 320 / 768 / 1280: the document must not scroll sideways, and the page must still match a committed screenshot. This one runs in CI and **fails the build**. Baselines are generated in CI, never locally — see [docs/layout-guardrail.md](docs/layout-guardrail.md).

## CI gates (on every push and PR)

1. Lint (`eslint`)
2. Type check (`tsc --noEmit`)
3. Unit tests with coverage (≥80% lines globally; 100% on `**/compliance/**` and `**/auth/**` when those directories exist)
4. Playwright E2E with axe-core accessibility check (WCAG 2.2 AA)
5. `npm audit --audit-level high`
6. Layout guardrail (`npm run test:layout`) — no horizontal overflow + committed screenshot baselines on `/dashboard` and `/account` at 320 / 768 / 1280. **Blocking.** See [docs/layout-guardrail.md](docs/layout-guardrail.md).

The Spec C4 responsive suite at 320 / 390 / 768 / 1280 / 1920 is **advisory and is not run by CI** — it is a local command (`npm run test:responsive`). Card 2.3.51 made the overflow half of it blocking, on the two pages above, as the gate at item 6.

## Key commands

```bash
npm run dev             # Development server
npm run build           # Production build
npm run lint            # ESLint
npm run type-check      # TypeScript
npm run test            # Vitest (unit tests)
npm run test:coverage   # Vitest with coverage report
npm run test:e2e        # Playwright E2E (desktop)
npm run test:responsive # Multi-viewport advisory gate (320 / 390 / 768 / 1280 / 1920)
npm run test:layout     # Layout guardrail — BLOCKING in CI (CI-generated baselines only)
```
