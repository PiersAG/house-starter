// Operator (control-plane) setting values — the settings that belong to whoever
// RUNS the app, not to any customer of it.
//
// WHAT LIVES HERE
// ---------------
// Trial length, comp/no-payment policy, the app's own name and its outbound-mail
// identity. One app = one brand, one trial policy; these are not per-customer
// facts and a customer must not be able to write them. `core.app_name` in
// particular is read by the root layout's generateMetadata on ANONYMOUS requests
// (the login page, the marketing pages, error pages), where there is no session
// and therefore no tenant — so it could not live in a tenant database even if we
// wanted it to.
//
// THE ACCESS MODEL — NOT A PRIVILEGE CHECK
// ----------------------------------------
// Nothing in the app writes this table. There is no route, no server action and
// no role that reaches it; the only writer is scripts/set-operator-setting.ts,
// a standalone CLI never imported by the app runtime (the same shape
// scripts/grant-access.ts uses, and for the same reason). A definition marked
// `operatorOnly` is refused by validateOwnerWrite and absent from
// visibleDefinitions(false), so it renders on no page and answers no write.
//
// That is deliberately stronger than "check the role first". A privilege check
// is a line of code that can be forgotten on the next route; an absent request
// path cannot be. The finding that produced this module was exactly a missing
// privilege check.
//
// DI pattern: the CATALOG database is always an explicit argument, like
// lib/users.ts. Passing a tenant database here would be a bug, and the value it
// wrote would be invisible to the operator surface — hence the argument name.

import { eq, sql } from "drizzle-orm";
import { operatorSettingValues } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";

/**
 * The stored operator value for `key`, or undefined when none is set.
 * `undefined` means "fall through to the factory default"; it is never a value.
 */
export async function getOperatorValue(
  catalogDb: AppDatabase,
  key: string,
): Promise<unknown | undefined> {
  const rows = await catalogDb
    .select({ value: operatorSettingValues.value })
    .from(operatorSettingValues)
    .where(eq(operatorSettingValues.key, key))
    .limit(1)
    .all();
  if (rows.length === 0) return undefined;
  return JSON.parse(rows[0].value) as unknown;
}

/**
 * Set (or replace) the operator value for `key`.
 *
 * Called by scripts/set-operator-setting.ts ONLY. No capability guard and no
 * owner-editable guard: the operator is the authority those guards exist to
 * defend against being overridden, and the CLI validates against the definition
 * before calling. What keeps this safe is that no request path reaches it.
 */
export async function setOperatorValue(
  catalogDb: AppDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  const encoded = JSON.stringify(value);
  await catalogDb
    .insert(operatorSettingValues)
    .values({ key, value: encoded })
    .onConflictDoUpdate({
      target: operatorSettingValues.key,
      set: { value: encoded, updatedAt: sql`(unixepoch())` },
    })
    .run();
}

/**
 * Clear the operator value for `key`, reverting it to the factory default.
 * Returns true when a row was removed.
 */
export async function deleteOperatorValue(
  catalogDb: AppDatabase,
  key: string,
): Promise<boolean> {
  const existing = await getOperatorValue(catalogDb, key);
  if (existing === undefined) return false;
  await catalogDb
    .delete(operatorSettingValues)
    .where(eq(operatorSettingValues.key, key))
    .run();
  return true;
}
