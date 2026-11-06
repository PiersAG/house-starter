// Print the evidence pack for one card dispute (PiersAG/app-business-core#370; the
// runbook docs/billing-disputes.md § 2). The same pack the deadline reminder emails:
// every field Stripe's dispute form asks for that the app knows, filled in.
//
//   npx tsx scripts/dispute-evidence.ts <stripe dispute id> [--app-url https://…]
//
// Read-only. Targets the catalog (CATALOG_DATABASE_URL / DATABASE_URL, as the app).

// First: lets this script load lib/ modules marked `import "server-only"` (issue 797).
import "./server-only-node.cjs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { resolveCatalog } from "../lib/catalog";
import type { AppDatabase } from "../lib/users";
import { assembleEvidence, renderEvidence } from "../lib/disputes/evidence";
import { getAppName } from "../lib/branding";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id || id.startsWith("--")) {
    console.error("Usage: npx tsx scripts/dispute-evidence.ts <stripe dispute id> [--app-url https://…]");
    process.exit(2);
  }
  const { url, authToken } = resolveCatalog();
  const remote = /^(libsql|https?|wss?):/i.test(url);
  const db = drizzle(createClient({ url, authToken: remote ? authToken : undefined })) as AppDatabase;
  const pack = await assembleEvidence(db, id, {
    appName: await getAppName(),
    baseUrl: arg("app-url") ?? process.env.APP_URL ?? "https://your-app.example",
  });
  if (!pack) {
    console.error(`No dispute ${id} is recorded in this app (the webhook records each one when it opens).`);
    process.exit(1);
  }
  console.log(renderEvidence(pack));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
