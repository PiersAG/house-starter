// The two-key overlap (decision D7) and the tenant token's own key (#484).
//
//   * a value sealed under the previous key still opens while the replacement is
//     under way, and is reported for re-sealing;
//   * new values are sealed under the current key only;
//   * tenant tokens get their own key (v2.), and v1. tokens under the MFA key
//     keep opening until they are re-sealed (existing keys unaffected);
//   * resealStoredSecrets moves every stored value onto the current keys.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import {
  MFA_KEY_ENV,
  MFA_PREVIOUS_KEY_ENV,
  TENANT_KEY_ENV,
  TENANT_PREVIOUS_KEY_ENV,
  TenantTokenSealError,
  loadPreviousSecretBoxKey,
  openSecret,
  openSecretWithRing,
  openTenantToken,
  openTenantTokenWithRing,
  sealSecret,
  sealTenantToken,
} from "@/lib/crypto/secret-box";
import { resealStoredSecrets } from "@/lib/crypto/reseal";
import { migrateCatalog } from "@/lib/migrate";
import { tenants, userMfaTotp } from "@/lib/schema";

const k = () => randomBytes(32).toString("base64");
const TOKEN = "eyJhbGciOiJFZERTQSJ9.tenant-db-token-not-real.sig";

describe("openSecretWithRing", () => {
  it("opens with the current key and needs no re-seal", () => {
    const cur = randomBytes(32);
    const r = openSecretWithRing(sealSecret("s3cret", cur, "u1"), cur, null, "u1");
    expect(r).toEqual({ plaintext: "s3cret", openedWithPrevious: false });
  });

  it("opens a value sealed under the previous key and says so", () => {
    const cur = randomBytes(32);
    const prev = randomBytes(32);
    const r = openSecretWithRing(sealSecret("s3cret", prev, "u1"), cur, prev, "u1");
    expect(r).toEqual({ plaintext: "s3cret", openedWithPrevious: true });
  });

  it("refuses when neither key opens it", () => {
    const sealed = sealSecret("s3cret", randomBytes(32), "u1");
    expect(() => openSecretWithRing(sealed, randomBytes(32), randomBytes(32), "u1")).toThrow();
    expect(() => openSecretWithRing(sealed, randomBytes(32), null, "u1")).toThrow();
  });

  it("reads the previous key only when one is set", () => {
    expect(loadPreviousSecretBoxKey({})).toBeNull();
    expect(loadPreviousSecretBoxKey({ [MFA_PREVIOUS_KEY_ENV]: k() })?.length).toBe(32);
    expect(() => loadPreviousSecretBoxKey({ [MFA_PREVIOUS_KEY_ENV]: "short" })).toThrow(
      /MFA_ENCRYPTION_KEY_PREVIOUS must be 32 bytes/,
    );
  });
});

describe("tenant tokens on their own key", () => {
  it("seals v2. under TENANT_DB_TOKEN_KEY when the deploy supplies it", () => {
    const env = { [MFA_KEY_ENV]: k(), [TENANT_KEY_ENV]: k() };
    const sealed = sealTenantToken(TOKEN, "T1", env);
    expect(sealed.startsWith("v2.")).toBe(true);
    expect(openTenantToken(sealed, "T1", env)).toBe(TOKEN);
    // the MFA key alone cannot open it: the two purposes have separate keys
    expect(() => openTenantToken(sealed, "T1", { [MFA_KEY_ENV]: env[MFA_KEY_ENV], [TENANT_KEY_ENV]: k() })).toThrow(
      TenantTokenSealError,
    );
  });

  it("keeps sealing v1. under the MFA key until the dedicated key is supplied", () => {
    const env = { [MFA_KEY_ENV]: k() };
    expect(sealTenantToken(TOKEN, "T1", env).startsWith("v1.")).toBe(true);
  });

  it("still opens v1. tokens once the dedicated key arrives, and marks them for re-sealing", () => {
    const mfa = k();
    const v1 = sealTenantToken(TOKEN, "T1", { [MFA_KEY_ENV]: mfa });
    const r = openTenantTokenWithRing(v1, "T1", { [MFA_KEY_ENV]: mfa, [TENANT_KEY_ENV]: k() });
    expect(r).toEqual({ plaintext: TOKEN, needsReseal: true });
    // without the dedicated key there is nothing to move to
    expect(openTenantTokenWithRing(v1, "T1", { [MFA_KEY_ENV]: mfa }).needsReseal).toBe(false);
  });

  it("opens a v2. token under the previous tenant key during a replacement", () => {
    const old = k();
    const sealed = sealTenantToken(TOKEN, "T1", { [MFA_KEY_ENV]: k(), [TENANT_KEY_ENV]: old });
    const env = { [MFA_KEY_ENV]: k(), [TENANT_KEY_ENV]: k(), [TENANT_PREVIOUS_KEY_ENV]: old };
    expect(openTenantTokenWithRing(sealed, "T1", env)).toEqual({ plaintext: TOKEN, needsReseal: true });
  });

  it("refuses a v2. token when the dedicated key is missing, naming the key", () => {
    const sealed = sealTenantToken(TOKEN, "T1", { [MFA_KEY_ENV]: k(), [TENANT_KEY_ENV]: k() });
    expect(() => openTenantToken(sealed, "T1", { [MFA_KEY_ENV]: k() })).toThrow(/TENANT_DB_TOKEN_KEY is not set/);
  });
});

describe("resealStoredSecrets", () => {
  let dir: string;
  let url: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hs-reseal-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(async () => {
    url = `file:${join(dir, `c-${randomBytes(4).toString("hex")}.db`)}`;
    await migrateCatalog(url);
  });

  async function seed(mfaKey: Buffer, tenantToken: string) {
    const c = createClient({ url });
    await c.execute("INSERT INTO users (id, email, password_hash) VALUES ('u1','a@example.test','!')");
    const s = sealSecret("JBSWY3DPEHPK3PXP", mfaKey, "u1");
    await c.execute({
      sql: "INSERT INTO user_mfa_totp (id, user_id, secret_ciphertext, secret_iv, secret_tag) VALUES ('m1','u1',?,?,?)",
      args: [s.ciphertext, s.iv, s.tag],
    });
    await c.execute({
      sql: "INSERT INTO tenants (id, db_url, db_auth_token, provisioner) VALUES ('T1','libsql://t1.example.test',?,'turso')",
      args: [tenantToken],
    });
    c.close();
  }

  it("moves every value onto the current keys, then has nothing left to do", async () => {
    const oldMfa = randomBytes(32);
    const newMfa = randomBytes(32);
    await seed(oldMfa, sealTenantToken(TOKEN, "T1", { [MFA_KEY_ENV]: oldMfa.toString("base64") }));
    const tenantKey = k();
    const env = {
      [MFA_KEY_ENV]: newMfa.toString("base64"),
      [MFA_PREVIOUS_KEY_ENV]: oldMfa.toString("base64"),
      [TENANT_KEY_ENV]: tenantKey,
    };
    const db = drizzle(createClient({ url })) as never;
    const r = await resealStoredSecrets(db, env);
    expect(r).toEqual({ mfaChecked: 1, mfaResealed: 1, tokensChecked: 1, tokensResealed: 1, failed: [] });

    // the old keys are no longer needed
    const after = { [MFA_KEY_ENV]: newMfa.toString("base64"), [TENANT_KEY_ENV]: tenantKey };
    const d = drizzle(createClient({ url }));
    const f = (await d.select().from(userMfaTotp).all())[0];
    expect(openSecret({ ciphertext: f.secretCiphertext, iv: f.secretIv, tag: f.secretTag }, newMfa, "u1")).toBe(
      "JBSWY3DPEHPK3PXP",
    );
    const t = (await d.select().from(tenants).all())[0];
    expect(t.dbAuthToken?.startsWith("v2.")).toBe(true);
    expect(openTenantToken(String(t.dbAuthToken), "T1", after)).toBe(TOKEN);

    const again = await resealStoredSecrets(db, after);
    expect(again.mfaResealed + again.tokensResealed).toBe(0);
  });

  it("needs no key when nothing is stored, and skips a tenant with no token", async () => {
    const c = createClient({ url });
    await c.execute("INSERT INTO tenants (id, db_url, provisioner) VALUES ('T2','file:x.db','file')");
    c.close();
    const db = drizzle(createClient({ url })) as never;
    expect(await resealStoredSecrets(db, {})).toEqual({
      mfaChecked: 0,
      mfaResealed: 0,
      tokensChecked: 0,
      tokensResealed: 0,
      failed: [],
    });
  });

  it("reports a row that opens with neither key and changes nothing for it", async () => {
    await seed(randomBytes(32), sealTenantToken(TOKEN, "T1", { [MFA_KEY_ENV]: k() }));
    const db = drizzle(createClient({ url })) as never;
    const r = await resealStoredSecrets(db, { [MFA_KEY_ENV]: k() });
    expect(r.failed.sort()).toEqual(["tenants:T1", "user_mfa_totp:m1"]);
    expect(r.mfaResealed + r.tokensResealed).toBe(0);
  });
});
