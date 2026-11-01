// Stop silent overwrites (app-business-core issue 536; Matt Murphy #269, #81).
//
// The template's update path — a setting's stored value — carries a version.
// A write naming the version it was based on succeeds only while that version
// is current; a stale second write is refused (VersionConflictError, which the
// route answers 409) and the first save survives. Every change is appended to
// record_events, an append-only history. A write naming no version is
// last-write-wins, the rule allowed for settings.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import type { AppDatabase } from "@/lib/users";
import { VersionConflictError, recordHistory } from "@/lib/records/history";
import {
  deleteValue,
  getStoredValue,
  getStoredVersion,
  setClientValue,
  setOwnerValue,
} from "@/lib/settings/values";

const KEY = "core.client_self_registration";
let client: Client;
let db: AppDatabase;

beforeEach(async () => {
  client = createMigrationDatabase(":memory:");
  await runMigrations(client);
  db = drizzle(client) as AppDatabase;
});
afterEach(() => client.close());

describe("optimistic concurrency on record updates", () => {
  it("nothing stored is version 0; each write adds one", async () => {
    expect(await getStoredVersion(db, KEY, "owner")).toBe(0);
    expect(await setOwnerValue(db, KEY, true, { expectedVersion: 0 })).toBe(1);
    expect(await setOwnerValue(db, KEY, false, { expectedVersion: 1 })).toBe(2);
    expect(await getStoredVersion(db, KEY, "owner")).toBe(2);
  });

  it("a stale second write is refused and the first save survives", async () => {
    await setOwnerValue(db, KEY, false, { expectedVersion: 0 }); // v1
    // two screens both showing v1
    expect(await setOwnerValue(db, KEY, true, { expectedVersion: 1, actor: "device-a" })).toBe(2);
    const stale = setOwnerValue(db, KEY, false, { expectedVersion: 1, actor: "device-b" });
    await expect(stale).rejects.toBeInstanceOf(VersionConflictError);
    await expect(stale).rejects.toMatchObject({ expected: 1, current: 2 });
    expect(await getStoredValue(db, KEY, "owner")).toBe(true);
  });

  it("a first write that races another first write is refused too", async () => {
    await setOwnerValue(db, KEY, true, { expectedVersion: 0 });
    await expect(setOwnerValue(db, KEY, false, { expectedVersion: 0 })).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("a write naming no version is last-write-wins (settings and profiles only)", async () => {
    await setOwnerValue(db, KEY, true, { expectedVersion: 0 });
    expect(await setOwnerValue(db, KEY, false)).toBe(2);
    expect(await getStoredValue(db, KEY, "owner")).toBe(false);
  });

  it("client preferences are versioned per client", async () => {
    expect(await setClientValue(db, KEY, "client-1", true, { expectedVersion: 0 })).toBe(1);
    expect(await setClientValue(db, KEY, "client-2", true, { expectedVersion: 0 })).toBe(1);
    await expect(setClientValue(db, KEY, "client-1", false, { expectedVersion: 0 })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
  });
});

describe("every change is kept as an immutable event", () => {
  it("records created, updated and deleted, in order, with who did it", async () => {
    await setOwnerValue(db, KEY, true, { expectedVersion: 0, actor: "user-1" });
    await setOwnerValue(db, KEY, false, { expectedVersion: 1, actor: "user-2" });
    await deleteValue(db, KEY, "owner", undefined, { actor: "user-1" });
    const history = await recordHistory(db, "setting", KEY);
    expect(history.map((e) => [e.action, e.version, e.data, e.actor])).toEqual([
      ["created", 1, true, "user-1"],
      ["updated", 2, false, "user-2"],
      ["deleted", 0, null, "user-1"],
    ]);
    for (const e of history) expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a refused write leaves no event", async () => {
    await setOwnerValue(db, KEY, true, { expectedVersion: 0 });
    await setOwnerValue(db, KEY, false, { expectedVersion: 5 }).catch(() => {});
    expect((await recordHistory(db, "setting", KEY)).length).toBe(1);
  });
});
