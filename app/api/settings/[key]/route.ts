// PUT/DELETE /api/settings/[key] — write or clear a setting value
// (settings-registry-spec §3 · validation at the API layer).
//
// PUT sets an override; DELETE reverts to fall-through (never a copied value).
// Validation — unknown-key rejection, value_type, bounds, owner_editable — is
// enforced here via lib/settings/validation before any write. Owner writes need
// an authenticated session; client-scope writes act only on the caller's own
// preference (clientId is taken from the session, never the body).
//
// Verified via E2E (excluded from unit coverage like every app/api/** route);
// the validation and value-store logic is unit-tested directly.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
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

  const removed =
    scope === "client"
      ? await deleteValue(db, key, "client", userId)
      : await deleteValue(db, key, "owner");

  return NextResponse.json({ ok: true, key, scope, reverted: removed });
}
