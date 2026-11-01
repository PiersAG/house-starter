// Ownership check for every endpoint that takes a record id
// (app-business-core issue 770; Matt Murphy #53: "add ownership verification
// middleware so that it compares the authenticated session user against the
// resource owner on every protected endpoint").
//
// TWO LAYERS, and a generated feature needs both:
//   * The tenant boundary is structural: a tenant's records are in its OWN
//     database (lib/tenant-context.ts::getTenantDb), so another tenant's row is
//     not there to be found.
//   * Inside a tenant, a record that belongs to one person (a client's booking,
//     a staff member's notes) is checked against the session user here, before
//     it is returned or changed. Today one account = one tenant, so the owner
//     owns everything; this is in place before staff accounts exist (#531),
//     not found one route at a time afterwards.
//
// A record the caller does not own is answered exactly like a record that does
// not exist (404), so an id that belongs to someone else reveals nothing.
//
// IDs are random (crypto.randomUUID) everywhere — never sequential numbers —
// so an id cannot be guessed by counting (Matt Murphy #53, #140). The template
// test tests/unit/id-ownership-audit.test.ts lists every endpoint that takes an
// id and fails one with no ownership check; the factory's security gate fails
// a sequential-integer primary key (factory.sequential-integer-id).

import { NextResponse } from "next/server";

/** The session fields this check needs. */
export interface OwnerSession {
  user?: { id?: string | null; role?: string | null } | null;
}

/** A record that belongs to one user: the id of its owner. */
export interface OwnedRecord {
  ownerId: string | null;
}

/** The record is absent, or belongs to someone else — both look the same. */
export class NotFoundOrNotOwnedError extends Error {
  constructor() {
    super("Not found.");
    this.name = "NotFoundOrNotOwnedError";
  }
}

/**
 * True when the signed-in user may act on this record: they own it, or they
 * are the workspace owner (who owns every record in their own database).
 */
export function owns(session: OwnerSession | null | undefined, record: OwnedRecord): boolean {
  const userId = session?.user?.id;
  if (!userId) return false;
  if (session?.user?.role === "owner") return true;
  return record.ownerId !== null && record.ownerId === userId;
}

/**
 * Load a record by id and return it only if the caller owns it. Throws
 * NotFoundOrNotOwnedError when it is missing or not theirs.
 */
export async function loadOwned<T extends OwnedRecord>(
  session: OwnerSession | null | undefined,
  load: () => Promise<T | null | undefined>,
): Promise<T> {
  if (!session?.user?.id) throw new NotFoundOrNotOwnedError();
  const record = await load();
  if (!record || !owns(session, record)) throw new NotFoundOrNotOwnedError();
  return record;
}

/** The 404 a route answers for NotFoundOrNotOwnedError, or null for anything else. */
export function notOwnedResponse(error: unknown): Response | null {
  return error instanceof NotFoundOrNotOwnedError
    ? NextResponse.json({ error: "Not found." }, { status: 404 })
    : null;
}
