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

## CI gates (on every push and PR)

1. Lint (`eslint`)
2. Type check (`tsc --noEmit`)
3. Unit tests with coverage (≥80% lines globally; 100% on `**/compliance/**` and `**/auth/**` when those directories exist)
4. Playwright E2E with axe-core accessibility check (WCAG 2.2 AA)
5. `npm audit --audit-level high`

## Key commands

```bash
npm run dev          # Development server
npm run build        # Production build
npm run lint         # ESLint
npm run type-check   # TypeScript
npm run test         # Vitest (unit tests)
npm run test:coverage # Vitest with coverage report
npm run test:e2e     # Playwright E2E
```
