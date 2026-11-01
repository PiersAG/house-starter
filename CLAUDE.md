# Session rules (non-negotiable)

Read DESIGN.md before writing any UI code.
Read docs/responsive.md before writing any UI code — components ask their
container (@sm:/@roomy:), pages ask the viewport (sm:/md:), sizes are fluid.
Tabular data goes in components/ui/data-table.tsx — read docs/data-tables.md.
Never hand-roll a <table>: it is the one thing that cannot reflow, and a wide
one pushes the whole page sideways rather than just itself.
Read BUILD-BRIEF.md before writing any feature code.
Never touch production credentials.
Never delete data without explicit human approval.
Never skip tests.
Ask before any destructive operation.
Commit after each working increment, not at end of session.

# Input, data and code rules (enforced by the factory's security gate and lint)

Validate every request with lib/validation/input.ts before business logic:
parseForm() in server actions, schema.safeParse() for bodies and route params,
parseQuery() for query strings. Never .passthrough().
SQL: bound arguments or Drizzle only; splice only sqlIdent()/sqlColumnDef().
Ids are crypto.randomUUID(); every endpoint that takes an id uses
loadOwned()/owns() from lib/ownership.ts.
Cache keys: tenantCacheKey() (lib/cache-key.ts). Email HTML: the html tag
(lib/email/templates/html.ts). User-supplied URLs: fetchUserUrl()
(lib/outbound-fetch.ts). No file path from request input; no blob columns;
no public storage. Records carry a version; a stale save is a 409
(lib/records/history.ts).
Files at most 400 lines of code, functions 200; split into coherent modules.
