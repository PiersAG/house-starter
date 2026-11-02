// Changing an account's role inside its tenant, with its audit row
// (PiersAG/app-business-core#796: "modifying permissions … none of it is logged").
//
// lib/authz.ts reads the role; this is the one place that writes it, so every
// change is in the audit trail (lib/audit/trail.ts). Access grants (the paywall
// exemption) are audited in lib/billing/grants.ts.

import "server-only";

import { eq } from "drizzle-orm";
import { recordAuditEvent } from "@/lib/audit/trail";
import { USER_ROLES, users, type UserRole } from "@/lib/schema";
import { getUserById, type AppDatabase } from "@/lib/users";

/** Set `userId`'s role. Returns false when there is no such account. */
export async function setUserRole(
  db: AppDatabase,
  userId: string,
  role: UserRole,
  actor: string,
  auditDb?: AppDatabase,
): Promise<boolean> {
  if (!(USER_ROLES as readonly string[]).includes(role)) {
    throw new Error(`lib/account/roles.ts: unknown role ${JSON.stringify(role)}`);
  }
  const user = await getUserById(db, userId);
  if (!user) return false;
  if (user.role === role) return true;
  await db.update(users).set({ role }).where(eq(users.id, userId)).run();
  await recordAuditEvent(
    {
      action: "permissions_changed",
      actor,
      subjectUserId: userId,
      tenantId: user.tenantId ?? null,
      target: "role",
      before: user.role,
      after: role,
    },
    auditDb ?? db,
  );
  return true;
}
