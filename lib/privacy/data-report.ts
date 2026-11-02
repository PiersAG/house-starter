// The data report: everything the app holds on one account (app-business-core
// issues 722 and 351; Matt Murphy #156: "generate a data report of everything
// you hold on that user"; LEGAL.05: an "export my data" button answers most
// subject access requests at once).
//
// Built from the personal-data map (config/personal-data.ts), so the report
// covers exactly the tables the deletion pipeline erases. Each table's rows for
// the account are included with every column EXCEPT:
//   * secret columns (config/data-classification.ts): password and token hashes,
//     sealed keys — never sent anywhere;
//   * the reserved internal ids that the browser boundary never carries (Stripe
//     ids, session ids, database addresses): shown as "held" with what they are,
//     so the report says the app holds them without sending them.
// The account's own database is included table by table. Places outside the
// database (rate-limit counters, host logs, backups) are listed with what they
// hold and how deletion reaches them.

import "server-only";

import { sql } from "drizzle-orm";
import { DATA_CLASSIFICATION } from "@/config/data-classification";
import { OUTSIDE_LOCATIONS, PERSONAL_DATA_MAP } from "@/config/personal-data";
import type { AppDatabase } from "@/lib/users";
import { users } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { tableNamed } from "@/lib/privacy/tables";
import { ownTenant, subjectWhere } from "@/lib/privacy/subject";
import { subjectOf } from "@/lib/privacy/deletion";
import { sqlIdent } from "@/lib/sql-ident";

/** Internal ids the report names as held rather than printing (see above). */
const HELD_NOT_SHOWN: Record<string, string> = {
  stripeCustomerId: "your customer id at Stripe",
  stripeSubscriptionId: "your subscription id at Stripe",
  stripeChargeId: "a payment id at Stripe",
  jti: "a signed-in session's id",
  dbUrl: "your database's address",
  hostedInvoiceUrl: "the link to the invoice at Stripe",
};

export interface DataReportSection {
  table: string;
  category: string;
  purpose: string;
  rows: Record<string, unknown>[];
}

export interface DataReport {
  generatedAt: string;
  accountId: string;
  sections: DataReportSection[];
  ownDatabase: { table: string; rows: Record<string, unknown>[] }[];
  elsewhere: { name: string; what: string; deletion: string }[];
}

function isSecret(table: string, column: string): boolean {
  return DATA_CLASSIFICATION[table]?.[column]?.class === "secret";
}

function present(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (isSecret(table, k)) continue;
    if (k in HELD_NOT_SHOWN) {
      if (v !== null && v !== undefined) out[k] = `held: ${HELD_NOT_SHOWN[k]}`;
      continue;
    }
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/** The report for one account. `tenant` is its own database, when it has one. */
export async function buildDataReport(
  db: AppDatabase,
  userId: string,
  opts: { tenant?: AppDatabase | null; now?: Date } = {},
): Promise<DataReport | null> {
  const found = await db.select().from(users).where(eq(users.id, userId)).limit(1).all();
  const user = found[0];
  if (!user) return null;
  const subject = await subjectOf(db, user);
  const sections: DataReportSection[] = [];
  for (const [name, entry] of Object.entries(PERSONAL_DATA_MAP)) {
    if (entry.plane !== "catalog") continue;
    const table = tableNamed(name);
    const where = subjectWhere(entry, table, subject);
    if (!where) continue;
    const rows = (await db.select().from(table).where(where).all()) as Record<string, unknown>[];
    if (rows.length === 0) continue;
    sections.push({
      table: name,
      category: entry.category,
      purpose: entry.purpose,
      rows: rows.map((r) => present(name, r)),
    });
  }
  const ownDatabase: DataReport["ownDatabase"] = [];
  if (opts.tenant && ownTenant(subject.tenantId)) {
    const names = await opts.tenant.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    );
    for (const { name } of names) {
      const rows = await opts.tenant.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${sqlIdent(name)}`));
      ownDatabase.push({ table: name, rows });
    }
  }
  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    accountId: userId,
    sections,
    ownDatabase,
    elsewhere: OUTSIDE_LOCATIONS.map((l) => ({ name: l.name, what: l.what, deletion: l.deletion })),
  };
}
