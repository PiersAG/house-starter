// The check on the daily retention call (app/api/cron/retention): Vercel's
// scheduler sends `Authorization: Bearer <CRON_SECRET>`. Compared in constant
// time, so the answer's timing says nothing about the secret.

import "server-only";

import { timingSafeEqual } from "node:crypto";

/** True when `header` is exactly `Bearer <secret>`. False when either is missing. */
export function cronAuthorised(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}
