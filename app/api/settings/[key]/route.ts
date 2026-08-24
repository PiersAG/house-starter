// PUT/DELETE /api/settings/[key] — write or clear a setting value
// (settings-registry-spec §3 · validation at the API layer).
//
// PUT sets an override; DELETE reverts to fall-through (never a copied value).
// Validation — unknown-key rejection, value_type, bounds, owner_editable,
// operator-only — is enforced here via lib/settings/validation before any write.
// Client-scope writes act only on the caller's own preference (clientId is taken
// from the session, never the body).
//
// WHICH DATABASE THIS WRITES (finding 1). The TENANT'S OWN, via getTenantDb().
// It used to write the catalog, where setting_values had primary key
// `(key, scope, client_id)` and no tenant column — so `scope='owner'` was ONE
// GLOBAL ROW and any signed-in account set the value every other tenant read.
// The handle this route now holds is a connection to the caller's own database;
// there is no tenant filter to get wrong, because another tenant's row is not
// present to be returned.
//
// AND WHO MAY WRITE IT. Authentication is not authorization: the old check was
// `if (!userId) 401` and nothing more, so "is anyone signed in" was the whole
// of it. Owner-scope writes now require the tenant-owner role
// (lib/authz.ts::requireTenantOwner). Today one account = one tenant so every
// caller passes it; it is marked BEFORE sub-users exist rather than retrofitted
// one route at a time afterwards.
//
// WHAT THIS ROUTE CANNOT DO AT ALL: write an operator/CEO control. Those are
// not role-gated here, they are absent from this surface — validateOwnerWrite
// refuses them and operator_setting_values has no route. See
// lib/settings/operator.ts.
//
// Verified via E2E (excluded from unit coverage like every app/api/** route);
// the validation and value-store logic is unit-tested directly.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getTenantDb } from "@/lib/tenant-context";
import { NotAuthorizedError, assertTenantOwner } from "@/lib/authz";
import { requireCapabilityForSettingKey } from "@/lib/capabilities/guard";
import {
  validateOwnerWrite,
  validateClientWrite,
} from "@/lib/settings/validation";
import {
  setOwnerValue,
  setClientValue,
  deleteValue,
} from "@/lib/settings/values";

export const runtime = "nodejs";

/**
 * 403 when the caller is not the tenant owner, null when they are. Takes the
 * session the handler ALREADY resolved rather than calling auth() a second time
 * — two reads of the same fact in one request is two chances to get two answers.
 *
 * Returned rather than thrown so the two handlers stay linear; NotAuthorizedError
 * is the shared vocabulary (lib/authz.ts) and anything else is a real fault worth
 * surfacing as a 500 rather than swallowing as a refusal.
 */
function ownerRoleRefusal(session: Parameters<typeof assertTenantOwner>[0]): Response | null {
  try {
    assertTenantOwner(session);
    return null;
  } catch (error) {
    if (error instanceof NotAuthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}

/**
 * DELETE carries no body, so it never reaches validateOwnerWrite — this is the
 * arm that stops a DELETE from being the unguarded door a PUT is not. Clearing
 * an operator key would be a write to a control the app must not touch; it is
 * refused with the same message and code a PUT gets.
 */
function operatorKeyRefusal(key: string): Response | null {
  const validation = validateOwnerWrite(key, undefined);
  if (!validation.ok && validation.code === "operator_only") {
    return NextResponse.json({ error: validation.message }, { status: 422 });
  }
  return null;
}

const putSchema = z.object({
  value: z.unknown(),
  scope: z.enum(["owner", "client"]).default("owner"),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params;

  // R2: a write to a key whose capability is OFF is answered 404 — the key must
  // look absent, not hidden. Checked BEFORE auth so an off capability leaks
  // nothing (no 401 that would confirm the key exists).
  const disabled = requireCapabilityForSettingKey(key);
  if (disabled) return disabled;

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "You must be signed in to change settings." },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  const parsed = putSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { value, scope } = parsed.data;

  const validation =
    scope === "client"
      ? validateClientWrite(key, value)
      : validateOwnerWrite(key, value);
  if (!validation.ok) {
    // Unknown key → 404; every other rejection is a 422 with a plain message.
    const status = validation.code === "unknown_key" ? 404 : 422;
    return NextResponse.json({ error: validation.message }, { status });
  }

  // Owner scope changes the whole tenant's behaviour; a client preference
  // changes only the caller's own. Only the former needs the role.
  if (scope === "owner") {
    const refusal = ownerRoleRefusal(session);
    if (refusal) return refusal;
  }

  const db = await getTenantDb();
  if (scope === "client") {
    await setClientValue(db, key, userId, validation.value);
  } else {
    await setOwnerValue(db, key, validation.value);
  }
  return NextResponse.json({ ok: true, key, scope });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params;

  // R2: clearing a value is also a write to the gated surface — 404 when the
  // key's capability is off (same reasoning as PUT), before auth.
  const disabled = requireCapabilityForSettingKey(key);
  if (disabled) return disabled;

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "You must be signed in to change settings." },
      { status: 401 },
    );
  }

  const scope =
    new URL(request.url).searchParams.get("scope") === "client"
      ? "client"
      : "owner";

  // Clearing a value CHANGES the effective value, so it is a write and carries
  // the same authorization as PUT. A delete-only privilege hole is still a hole.
  if (scope === "owner") {
    const refusal = ownerRoleRefusal(session);
    if (refusal) return refusal;
    const operatorRefusal = operatorKeyRefusal(key);
    if (operatorRefusal) return operatorRefusal;
  }

  const db = await getTenantDb();
  const removed =
    scope === "client"
      ? await deleteValue(db, key, "client", userId)
      : await deleteValue(db, key, "owner");

  return NextResponse.json({ ok: true, key, scope, reverted: removed });
}
