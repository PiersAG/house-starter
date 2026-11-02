// Runs the retention job once by hand (app-business-core issues 722 and 791):
// erases accounts whose 30 days are up, deletes expired retained records and
// rows past their age limit. The scheduled call to /api/cron/retention does the
// same every day; this is for an operator, or a restore drill.
//
//   npm run privacy:run-retention

import "./server-only-node.cjs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { resolveCatalog } from "../lib/catalog";
import type { AppDatabase } from "../lib/users";
import { runRetentionJob } from "../lib/privacy/retention-job";
import { liveTenantPlane, sendErasureConfirmation } from "../lib/privacy/runtime";

async function main(): Promise<void> {
  const { url, authToken } = resolveCatalog();
  const db = drizzle(createClient({ url, authToken })) as unknown as AppDatabase;
  const run = await runRetentionJob(db, { tenantPlane: liveTenantPlane, confirm: sendErasureConfirmation });
  console.log(
    JSON.stringify({
      erased: run.erased.map((r) => ({ userId: r.userId, verified: r.verified, remaining: r.remaining })),
      expiredRetained: run.expiredRetained,
      purged: run.purged,
    }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
