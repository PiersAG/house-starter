// Print the change-log entry a DDL change still needs, with its reverse SQL
// drafted (app-business-core issue 777). Paste it into lib/migrations/changes.ts,
// fill in the summary, and check the reverse.
//
//   npx tsx scripts/schema-change-draft.ts
//
// Exit 0 = the change log already covers the DDL; 1 = an entry is needed.

// First: lets this script load lib/ modules marked `import "server-only"` (issue 797).
import "./server-only-node.cjs";
import { CATALOG_MIGRATION_SQL, TENANT_MIGRATION_SQL } from "../lib/migrate";
import { SCHEMA_CHANGES } from "../lib/migrations/changes";
import { draftReverse, expectedNames } from "../lib/migrations/reverse";
import { declaredNames } from "../lib/migrations/schema";

let needed = 0;
const today = new Date().toISOString().slice(0, 10);
for (const [plane, ddl] of [
  ["catalog", CATALOG_MIGRATION_SQL],
  ["tenant", TENANT_MIGRATION_SQL],
] as const) {
  const expected = expectedNames(SCHEMA_CHANGES, plane);
  const adds = [...declaredNames(ddl)].filter((n) => !expected.has(n)).sort();
  if (!adds.length) continue;
  needed++;
  console.log(
    JSON.stringify(
      {
        id: `${String(SCHEMA_CHANGES.length + needed).padStart(4, "0")}-<name>`,
        date: today,
        plane,
        kind: "expand",
        summary: "<what this change is for>",
        adds,
        reverse: draftReverse(adds),
      },
      null,
      2,
    ),
  );
}
if (!needed) console.log("The change log covers the DDL: nothing to add.");
process.exit(needed ? 1 : 0);
