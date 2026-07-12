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
| DB schema | `lib/db/schema.ts` | Schema is app-specific |
| Error tracking (Sentry) | `sentry.config.ts`, `app/global-error.tsx` | Configured at MVP boundary |

### Tenant migration fan-out (per-tenant apps only)

After a schema change lands, the tenancy migration fan-out applies the new schema
across every tenant database in one run. Tenant DBs follow the naming convention
`<app_slug>-<tenant_id>` in Turso, and the platform database list is the source of
truth (no registry file). Operator runbook:

```bash
# One-time per environment
export TURSO_API_TOKEN=...    # Turso platform token
export TURSO_ORG=...           # Turso organisation slug
export APP_SLUG=<slug>         # this app's slug — matches Turso DB name prefix

# Dry-run to preview targets (no writes)
npm run db:migrate:all-tenants -- --dry-run

# Apply migrations to every tenant DB (per-DB failures isolated; report written)
npm run db:migrate:all-tenants

# Re-run a single failed tenant (idempotent — safe)
npm run db:migrate:all-tenants -- --tenant <tenant_id>

# Verify every tenant has point-in-time restore enabled (Stage 0 backup gate)
npm run db:verify-tenant-backups
```

Refuses to run when `TENANCY_MODE=shared` — shared apps have one database and use
`npm run db:migrate` (drizzle-kit). Reports are written to
`migration-report-<timestamp>.json` and `pitr-report-<timestamp>.json` in the
current working directory. Spec: `wiki/specs/tenancy-migration-fanout.md` in
app-business-core; ADR-023 records the naming convention.

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
npm run dev
```

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

**Gate:** `npm run test:responsive` runs the E2E suite at all five widths with axe-core, no-horizontal-overflow, and touch-target checks. Ships **advisory** — failures are reported but do not fail the build. Flip to blocking with `RESPONSIVE_GATE=blocking npm run test:responsive`.

## CI gates (on every push and PR)

1. Lint (`eslint`)
2. Type check (`tsc --noEmit`)
3. Unit tests with coverage (≥80% lines globally; 100% on `**/compliance/**` and `**/auth/**` when those directories exist)
4. Playwright E2E with axe-core accessibility check (WCAG 2.2 AA)
5. `npm audit --audit-level high`
6. Responsive suite at 320 / 390 / 768 / 1280 / 1920 — **advisory** (reports; does not block). Flip with `RESPONSIVE_GATE=blocking`.

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
```
