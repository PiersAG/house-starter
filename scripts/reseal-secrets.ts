// Re-seal every stored secret under the current keys — a thin wrapper around
// lib/crypto/reseal.ts (decision D7, two-key overlap). The key replacement runs
// this after the new key is live and before the old one (<NAME>_PREVIOUS) is
// dropped; it is also safe to run by hand at any time.
//
//   tsx scripts/reseal-secrets.ts
//
// Needs the catalog (CATALOG_DATABASE_URL or DATABASE_URL, with its token) and
// the keys: MFA_ENCRYPTION_KEY (+ _PREVIOUS during a replacement), and
// TENANT_DB_TOKEN_KEY (+ _PREVIOUS) once the app has it. Prints counts and row
// ids only, never a value. Exits 1 if any value opened with neither key.

import { getCatalogDb } from "../lib/catalog";
import { resealStoredSecrets } from "../lib/crypto/reseal";

async function main(): Promise<void> {
  const r = await resealStoredSecrets(getCatalogDb());
  console.log(
    `two-factor secrets: ${r.mfaResealed} re-sealed of ${r.mfaChecked}; ` +
      `tenant database tokens: ${r.tokensResealed} re-sealed of ${r.tokensChecked}`,
  );
  if (r.failed.length > 0) {
    console.error(`could not open with the current or previous key: ${r.failed.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error("Re-seal failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
