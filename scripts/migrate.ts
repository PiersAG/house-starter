// Standalone migration entry point — a thin, logic-free wrapper.
//
// This file contains NO migration logic: it only imports and calls
// `migrate()` from lib/migrate.ts, which is the single covered source of
// truth for the schema DDL. It is EXCLUDED from coverage on purpose (the
// vitest coverage `include` covers only app/, components/, and lib/), so the
// standalone exit-0 requirement is verified without an uncoverable subprocess
// block sitting inside the measured code.
//
// Run with the project's TypeScript runner:  tsx scripts/migrate.ts
//   • dev/test: DATABASE_URL unset → defaults to an in-memory database
//   • dev file: DATABASE_URL=file:local.db
//   • prod:     DATABASE_URL=libsql://<host>  (+ DATABASE_AUTH_TOKEN)
//
// Exits 0 on success; a non-zero exit signals a failed migration.

import { migrate } from "../lib/migrate";

async function main(): Promise<void> {
  await migrate(process.env.DATABASE_URL, process.env.DATABASE_AUTH_TOKEN);
  console.log("Migration complete.");
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
