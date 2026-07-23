// scripts/grant-access.ts — the CEO CLI for the single audited paywall
// exemption (owner-account-paywall-exemption). This is the ONLY way an access
// grant is created, changed, or removed. It is a standalone script, never
// imported by the app runtime — so a grant cannot be minted implicitly (no
// signup hook, no env var, no email/pattern match).
//
//   tsx scripts/grant-access.ts grant  --email owner@x --type owner  [--note "creator"] [--expires 2026-12-31]
//   tsx scripts/grant-access.ts grant  --email qa@x    --type tester --expires 2026-08-31
//   tsx scripts/grant-access.ts revoke --email qa@x
//   tsx scripts/grant-access.ts list        # who currently has access without paying, and why
//
// Targets the app's primary DB via DATABASE_URL (+ DATABASE_AUTH_TOKEN). Set the
// owner's own account with `--type owner` (no --expires → never expires).
// Excluded from coverage (scripts/ is outside the coverage include), like
// scripts/migrate.ts.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getUserByEmail, getUserById, type AppDatabase } from "../lib/users";
import {
  grantAccess,
  revokeGrant,
  listLiveGrants,
  isGrantType,
  GRANT_TYPES,
} from "../lib/billing/grants";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function connect(): AppDatabase {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("grant-access: DATABASE_URL is required (the app's primary database).");
  const remote = /^(libsql|https?|wss?):/i.test(url);
  const client = createClient({ url, authToken: remote ? process.env.DATABASE_AUTH_TOKEN : undefined });
  return drizzle(client) as AppDatabase;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const db = connect();

  if (cmd === "list") {
    const grants = await listLiveGrants(db);
    if (grants.length === 0) {
      console.log("No live access grants — everyone reaching gated routes is paying.");
      return;
    }
    console.log("Accounts with access WITHOUT paying:");
    for (const g of grants) {
      const u = await getUserById(db, g.userId);
      const exp = g.expiresAt ? g.expiresAt.toISOString() : "never";
      console.log(
        `  ${u?.email ?? g.userId}  type=${g.type}  expires=${exp}  granted_by=${g.grantedBy ?? "?"}  note=${g.note ?? ""}`,
      );
    }
    return;
  }

  const email = flag("email");
  if (!email) throw new Error(`grant-access: --email is required for '${cmd}'.`);
  const user = await getUserByEmail(db, email);
  if (!user) throw new Error(`grant-access: no account found for ${email}.`);

  if (cmd === "revoke") {
    await revokeGrant(db, user.id);
    console.log(`Revoked access grant for ${email}.`);
    return;
  }

  if (cmd === "grant") {
    const type = flag("type");
    if (!type || !isGrantType(type)) {
      throw new Error(`grant-access: --type must be one of ${GRANT_TYPES.join(", ")}.`);
    }
    let expiresAt: Date | null = null;
    const expiresRaw = flag("expires");
    if (expiresRaw) {
      const d = new Date(expiresRaw);
      if (Number.isNaN(d.getTime())) {
        throw new Error(`grant-access: --expires ${JSON.stringify(expiresRaw)} is not a valid date.`);
      }
      expiresAt = d;
    }
    const g = await grantAccess(db, {
      userId: user.id,
      type,
      note: flag("note") ?? null,
      grantedBy: flag("by") ?? "ceo-cli",
      expiresAt,
    });
    console.log(`Granted ${g.type} access to ${email} (expires ${expiresAt ? expiresAt.toISOString() : "never"}).`);
    return;
  }

  console.error(
    "Usage: tsx scripts/grant-access.ts <grant|revoke|list> " +
      "[--email X --type owner|tester|comp --note '...' --expires YYYY-MM-DD]",
  );
  process.exit(2);
}

main().catch((error: unknown) => {
  console.error("grant-access failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
