// /api/health's `email` check (app-business-core issues 470 and 757), wired to
// the real settings and the recorded delivery reports. The verdict itself is
// lib/email/delivery.ts's judgeDelivery, unit-tested on its own.

import "server-only";

import { deliveryStats, judgeDelivery, WINDOW_DAYS, type EmailHealth } from "@/lib/email/delivery";
import { getEmailSendMode } from "@/lib/email/send";
import { checkSendingDomain } from "@/lib/email/sending-domain";
import { readSecret } from "@/lib/secrets";
import type { AppDatabase } from "@/lib/users";

/** Null in log mode (no check); otherwise the verdict. */
export async function emailHealth(
  db: AppDatabase,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<EmailHealth | null> {
  if (getEmailSendMode() !== "live") return null;
  const domain = checkSendingDomain(env);
  // Present or absent only: the value is never used here.
  const monitoringOn = Boolean((readSecret("EMAIL_EVENTS_SECRET", env) ?? "").trim());
  let stats = null;
  try {
    stats = await deliveryStats(db, now - WINDOW_DAYS * 86_400_000);
  } catch {
    stats = null;
  }
  return judgeDelivery({ domainOk: domain.ok, domainDetail: domain.detail, monitoringOn }, stats);
}
