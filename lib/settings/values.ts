// Per-tenant setting values — the read/write/delete layer over setting_values
// (settings-registry-spec §3). Values are stored JSON-encoded in a TEXT column;
// owner rows use the '' client-id sentinel (see lib/schema.ts). DI pattern: the
// database is always an explicit argument, like lib/users.ts.

import { and, eq, sql } from "drizzle-orm";
import { settingValues } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";
import type { SettingScope } from "@/lib/settings/types";

/** Owner-scope rows carry this sentinel in place of a client id (not NULL). */
export const OWNER_CLIENT_ID = "";

/**
 * Read the stored value at one exact level, or undefined if none is set there.
 * `undefined` means "fall through"; the resolver never treats it as a value.
 */
export async function getStoredValue(
  db: AppDatabase,
  key: string,
  scope: SettingScope,
  clientId: string = OWNER_CLIENT_ID,
): Promise<unknown | undefined> {
  const rows = await db
    .select({ value: settingValues.value })
    .from(settingValues)
    .where(
      and(
        eq(settingValues.key, key),
        eq(settingValues.scope, scope),
        eq(settingValues.clientId, clientId),
      ),
    )
    .limit(1)
    .all();
  if (rows.length === 0) return undefined;
  return JSON.parse(rows[0].value) as unknown;
}

async function upsert(
  db: AppDatabase,
  key: string,
  scope: SettingScope,
  clientId: string,
  value: unknown,
): Promise<void> {
  const encoded = JSON.stringify(value);
  await db
    .insert(settingValues)
    .values({ key, scope, clientId, value: encoded })
    .onConflictDoUpdate({
      target: [settingValues.key, settingValues.scope, settingValues.clientId],
      set: { value: encoded, updatedAt: sql`(unixepoch())` },
    })
    .run();
}

/** Set (or replace) the owner override for a key. */
export async function setOwnerValue(
  db: AppDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  await upsert(db, key, "owner", OWNER_CLIENT_ID, value);
}

/** Set (or replace) a client's preference for a key. */
export async function setClientValue(
  db: AppDatabase,
  key: string,
  clientId: string,
  value: unknown,
): Promise<void> {
  await upsert(db, key, "client", clientId, value);
}

/**
 * Delete a stored value, reverting that level to fall-through (never to a
 * copied value). Returns true if a row was removed.
 */
export async function deleteValue(
  db: AppDatabase,
  key: string,
  scope: SettingScope,
  clientId: string = OWNER_CLIENT_ID,
): Promise<boolean> {
  const existing = await getStoredValue(db, key, scope, clientId);
  if (existing === undefined) return false;
  await db
    .delete(settingValues)
    .where(
      and(
        eq(settingValues.key, key),
        eq(settingValues.scope, scope),
        eq(settingValues.clientId, clientId),
      ),
    )
    .run();
  return true;
}
