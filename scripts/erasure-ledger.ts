// The erasure ledger, for a database restore (app-business-core issues 745 and
// 352; Matt Murphy #203: deletion must reach backups). A restore to a point
// before some account erasures brings those accounts back. So:
//
//   1. BEFORE the restore, from the live database:
//        npm run privacy:export-ledger > ledger.json
//   2. Restore.
//   3. BEFORE the app reopens, against the restored database:
//        npm run privacy:replay-erasures -- ledger.json
//
// Step 3 erases every account in the ledger again (and its own database) and
// puts the ledger rows back. Uses the catalog the environment names
// (CATALOG_DATABASE_URL, else DATABASE_URL), like scripts/grant-access.ts.

import "./server-only-node.cjs";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { resolveCatalog } from "../lib/catalog";
import type { AppDatabase } from "../lib/users";
import { erasureLedger, replayErasures, type LedgerEntry } from "../lib/privacy/deletion";
import { liveTenantPlane } from "../lib/privacy/runtime";

async function main(): Promise<void> {
  const [cmd, file] = process.argv.slice(2);
  const { url, authToken } = resolveCatalog();
  const db = drizzle(createClient({ url, authToken })) as unknown as AppDatabase;
  if (cmd === "export") {
    process.stdout.write(JSON.stringify(await erasureLedger(db), null, 2) + "\n");
    return;
  }
  if (cmd === "replay" && file) {
    const ledger = JSON.parse(readFileSync(file, "utf8")) as LedgerEntry[];
    const again = await replayErasures(db, ledger, { tenantPlane: liveTenantPlane });
    console.log(`ledger: ${ledger.length} account(s); erased again: ${again.length}`);
    return;
  }
  console.error("Usage: erasure-ledger.ts export | replay <ledger.json>");
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
