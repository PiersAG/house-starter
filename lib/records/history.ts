// Record versions and change history (app-business-core issue 536; Matt Murphy
// #269, #81).
//
// THE CONFLICT RULE, chosen up front (Matt Murphy #269, step 1):
//   * Business records (anything a customer creates or edits as data — clients,
//     bookings, notes): OPTIMISTIC CONCURRENCY. Every row carries a `version`;
//     an update names the version it was based on, and a stale one is refused
//     (VersionConflictError → HTTP 409) instead of silently wiping the other
//     save. Every change is also appended to `record_events`, an append-only
//     history: the current row is the latest state, the events are the record
//     of every change (Matt Murphy #269, "store every change as an immutable
//     event").
//   * Settings and profiles: the same version check when the screen sends the
//     version it showed (the template's settings screen does); a caller that
//     sends none gets last-write-wins, the rule Matt Murphy allows for these.
//   * Live collaborative editing (two people typing in one document): neither
//     of the above — a CRDT, built when such a feature is (the build standard
//     says so; there is none in the template).
//   * The template runs in one region, so there is no multi-region merge to do
//     (Matt Murphy #81); the build standard names it for an app that ever does.
//
// `record_events` lives in each tenant's own database (lib/migrate.ts), next to
// the records it describes.

import { and, eq, sql } from "drizzle-orm";
import { recordEvents } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";

/** A write based on a version that is no longer current. */
export class VersionConflictError extends Error {
  constructor(
    readonly entity: string,
    readonly entityKey: string,
    readonly expected: number,
    readonly current: number,
  ) {
    super(
      `${entity} ${entityKey} was changed by someone else (version ${current}, ` +
        `this change was based on ${expected}). Reload to see the latest, then try again.`,
    );
    this.name = "VersionConflictError";
  }
}

export interface RecordEventInput {
  /** The kind of record, e.g. "setting". */
  entity: string;
  /** The record's key or id within its kind. */
  entityKey: string;
  /** The version the change produced (0 when the record was removed). */
  version: number;
  /** What happened. */
  action: "created" | "updated" | "deleted";
  /** The new state (JSON-serialisable), or null for a deletion. */
  data: unknown;
  /** Who made the change: a user id, or "system". */
  actor: string;
}

/** Append one event. Events are never updated or deleted. */
export async function appendRecordEvent(db: AppDatabase, event: RecordEventInput): Promise<void> {
  await db
    .insert(recordEvents)
    .values({
      id: crypto.randomUUID(),
      entity: event.entity,
      entityKey: event.entityKey,
      version: event.version,
      action: event.action,
      data: JSON.stringify(event.data ?? null),
      actor: event.actor,
    })
    .run();
}

export interface RecordEvent extends Omit<RecordEventInput, "data"> {
  id: string;
  data: unknown;
  occurredAt: Date;
}

/** A record's full history, in the order the changes happened. */
export async function recordHistory(
  db: AppDatabase,
  entity: string,
  entityKey: string,
): Promise<RecordEvent[]> {
  const rows = await db
    .select()
    .from(recordEvents)
    .where(and(eq(recordEvents.entity, entity), eq(recordEvents.entityKey, entityKey)))
    // insertion order (SQLite's rowid): the order the changes happened in
    .orderBy(sql`rowid`)
    .all();
  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    entityKey: r.entityKey,
    version: r.version,
    action: r.action as RecordEvent["action"],
    data: JSON.parse(r.data) as unknown,
    actor: r.actor,
    occurredAt: r.occurredAt,
  }));
}
