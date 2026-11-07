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

# What reaches the browser (bundle S10, enforced by the gate and the tests)

Everything a server component passes to a client component, and every route
answer, is sent to the browser. Query only the columns a page uses; pass and
answer DTOs: defineDto() / X.from() / dtoJson() (lib/dto.ts). Never a whole row,
never a spread object, never a field config/data-classification.ts marks
internal or secret; classify every new column there. Signed-in answers are
no-store. Modules touching the database, a key or a credential start with
import "server-only"; a "use client" file imports no server module and reads no
server env. NEXT_PUBLIC_ names are listed in config/public-env.ts. Every
POST/PUT/PATCH/DELETE route calls verifyCsrf() (signed out: verifySameOrigin())
from lib/csrf.ts; pages pass csrfTokenFor(session) to the client, which sends
x-csrf-token. Third-party scripts: config/third-party.ts and
components/ThirdPartyScripts.tsx only. Storage is private. Details:
docs/data-protection.md.

# Changing the database (enforced by tests/unit/migration-changes.test.ts)

A release only ADDS tables, columns or indexes: the code can be rolled back on
its own, the database cannot. Remove or rename something only in a later
release, once no live version reads it (a `contract` change). Every change to
lib/migrate.ts's DDL gets its entry in lib/migrations/changes.ts in the same
commit, with the SQL that reverses it — `npx tsx scripts/schema-change-draft.ts`
prints it. Recovery steps, targets and the rehearsal: docs/recovery.md.

# Tests and the correctness gate (enforced by tests/unit/test-independence.test.ts and tests/unit/browser-suite-coverage.test.ts)

Every new page goes in tests/support/routes.ts and every new form in
tests/support/forms.ts: the correctness gate then checks it for accessibility
(WCAG 2.2 AA, keyboard, contrast) and awkward input on every browser and device
(docs/correctness-gate.md). Each test makes its own data: uniqueEmail() and
addressFor() from tests/support/browser.ts, no fixed accounts, no serial mode;
the unit suite runs in random order. Wait for a condition, never a time: no
waitForTimeout, no sleeps (docs/test-independence.md).
