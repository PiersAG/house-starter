# House Starter

Clone this repo for each new app.

## Before writing any code

1. Run `python agents/build-design.py --build <id>` to generate `DESIGN.md` and `globals.css` tokens.
2. Copy the generated `globals.css` content into `app/globals.css`.
3. Read `BUILD-BRIEF.md` to understand what you're building.

## Stack

- Next.js 15 (App Router, TypeScript)
- Tailwind CSS v3 with token-driven colour system
- shadcn/ui components (add via `npx shadcn@latest add <component>`)
- Drizzle ORM
- NextAuth v5
- Vitest + Playwright
- Sentry

## Getting started

```bash
cp .env.example .env.local
# Fill in .env.local values
npm install
npm run dev
```

## CI gates (on every push and PR)

1. Lint (`eslint`)
2. Type check (`tsc --noEmit`)
3. Unit tests with coverage (≥80% lines globally; 100% on `**/compliance/**` and `**/auth/**`)
4. Playwright smoke test
5. `npm audit --audit-level high`
