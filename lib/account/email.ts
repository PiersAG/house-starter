// Changing an account's sign-in email, with its audit row (PiersAG/app-business-core#796).
//
// The template has no email-change screen yet; this is the one function any
// future screen, support tool or script must call, so the change is always in
// the audit trail (lib/audit/trail.ts): who changed it, from what, to what, when.

import "server-only";

import { eq } from "drizzle-orm";
import { recordAuditEvent } from "@/lib/audit/trail";
import { users } from "@/lib/schema";
import { getUserByEmail, getUserById, normalizeEmail, type AppDatabase } from "@/lib/users";
import { emailField } from "@/lib/validation/input";

export class EmailChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailChangeError";
  }
}

/**
 * Change `userId`'s email to `newEmail`. `actor` is who asked: the user's own
 * id, or "operator" for a support change. Throws EmailChangeError (a message
 * written for the user) when the address is invalid or already in use.
 */
export async function changeUserEmail(
  db: AppDatabase,
  userId: string,
  newEmail: string,
  actor: string,
  auditDb?: AppDatabase,
): Promise<void> {
  const parsed = emailField.safeParse(newEmail);
  if (!parsed.success) throw new EmailChangeError("Enter a valid email address.");
  const email = normalizeEmail(parsed.data);
  const user = await getUserById(db, userId);
  if (!user) throw new EmailChangeError("No such account.");
  if (user.email === email) return;
  const taken = await getUserByEmail(db, email);
  if (taken) throw new EmailChangeError("That email address is already in use.");
  await db.update(users).set({ email }).where(eq(users.id, userId)).run();
  await recordAuditEvent(
    {
      action: "email_changed",
      actor,
      subjectUserId: userId,
      tenantId: user.tenantId ?? null,
      target: "email",
      before: user.email,
      after: email,
    },
    auditDb ?? db,
  );
}
