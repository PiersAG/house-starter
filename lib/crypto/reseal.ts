// Re-seal every stored secret under the current keys (decision D7: app keys are
// replaced every 30 days with a two-key overlap).
//
// While a key is being replaced the old one is still readable as <NAME>_PREVIOUS.
// Before the replacement drops the old key, every value sealed under it must be
// sealed again under the new one, or it will never open again. This does that for
// the two kinds of sealed value the template stores, both in the catalog:
//
//   * two-factor secrets (user_mfa_totp)            — MFA_ENCRYPTION_KEY
//   * tenant database tokens (tenants.db_auth_token) — TENANT_DB_TOKEN_KEY, and
//     `v1.` tokens still under MFA_ENCRYPTION_KEY move to the dedicated key.
//
// Run by scripts/reseal-secrets.ts. Safe to run any time: a value already under
// the current key is left alone. Never prints, logs or returns a value.
//
// Node.js runtime only.

import { eq } from "drizzle-orm";
import type { getCatalogDb } from "@/lib/catalog";
import {
  loadPreviousSecretBoxKey,
  loadSecretBoxKey,
  openSecretWithRing,
  openTenantTokenWithRing,
  sealSecret,
  sealTenantToken,
} from "@/lib/crypto/secret-box";
import { tenants, userMfaTotp } from "@/lib/schema";

export interface ResealReport {
  mfaChecked: number;
  mfaResealed: number;
  tokensChecked: number;
  tokensResealed: number;
  /** Row ids whose value opened with no key — never the value. */
  failed: string[];
}

type Catalog = ReturnType<typeof getCatalogDb>;

export async function resealStoredSecrets(
  catalog: Catalog,
  env: Record<string, string | undefined> = process.env,
): Promise<ResealReport> {
  const report: ResealReport = {
    mfaChecked: 0,
    mfaResealed: 0,
    tokensChecked: 0,
    tokensResealed: 0,
    failed: [],
  };

  const factors = await catalog.select().from(userMfaTotp).all();
  if (factors.length > 0) {
    const key = loadSecretBoxKey(env);
    const previous = loadPreviousSecretBoxKey(env);
    for (const f of factors) {
      report.mfaChecked++;
      let opened: { plaintext: string; openedWithPrevious: boolean };
      try {
        opened = openSecretWithRing(
          { ciphertext: f.secretCiphertext, iv: f.secretIv, tag: f.secretTag },
          key,
          previous,
          f.userId,
        );
      } catch {
        report.failed.push(`user_mfa_totp:${f.id}`);
        continue;
      }
      if (!opened.openedWithPrevious) continue;
      const sealed = sealSecret(opened.plaintext, key, f.userId);
      await catalog
        .update(userMfaTotp)
        .set({
          secretCiphertext: sealed.ciphertext,
          secretIv: sealed.iv,
          secretTag: sealed.tag,
        })
        .where(eq(userMfaTotp.id, f.id))
        .run();
      report.mfaResealed++;
    }
  }

  const rows = await catalog.select({ id: tenants.id, token: tenants.dbAuthToken }).from(tenants).all();
  for (const r of rows) {
    if (r.token == null) continue;
    report.tokensChecked++;
    let opened: { plaintext: string; needsReseal: boolean };
    try {
      opened = openTenantTokenWithRing(r.token, r.id, env);
    } catch {
      report.failed.push(`tenants:${r.id}`);
      continue;
    }
    if (!opened.needsReseal) continue;
    await catalog
      .update(tenants)
      .set({ dbAuthToken: sealTenantToken(opened.plaintext, r.id, env) })
      .where(eq(tenants.id, r.id))
      .run();
    report.tokensResealed++;
  }
  return report;
}
