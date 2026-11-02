// A page that throws, for the crash-screen test only (app-business-core issue
// 502). Absent (404) unless the test server sets E2E_CRASH_ROUTE=1, so no live
// app ever shows it.

import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default function CrashCheck() {
  if (process.env.E2E_CRASH_ROUTE !== "1") notFound();
  throw new Error("crash-check: internal detail /srv/app/secret-path must never be shown");
}
