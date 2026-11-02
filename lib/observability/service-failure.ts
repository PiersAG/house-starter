// The answer an API route gives when an outside service (Stripe, the email
// provider, …) fails mid-request (PiersAG/app-business-core#373, Matt Murphy
// #108/#298): the user gets a plain message and a short support reference; the
// error itself — message, stack — goes only to the app's error log, under the
// same reference, so support can find it in seconds. Never the raw error text.

import { NextResponse } from "next/server";
import { recordError } from "@/lib/observability/error-log";

export interface ServiceFailureOptions {
  /** The route that failed, e.g. "/api/billing/checkout". */
  route: string;
  /** The plain-English message the user sees. */
  message: string;
  /** HTTP status; 502 (an outside service failed) by default. */
  status?: number;
}

/** A short reference the user can quote to support, e.g. "ref-3f9a2c1b". */
export function supportReference(): string {
  return `ref-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Log `err` under a fresh support reference and answer with only the plain message. */
export async function serviceFailure(
  err: unknown,
  opts: ServiceFailureOptions,
): Promise<NextResponse> {
  const reference = supportReference();
  await recordError({
    message: `${opts.route}: outside service failed`,
    stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
    route: opts.route,
    method: "POST",
    digest: reference,
    context: { reference },
  });
  return NextResponse.json(
    { error: opts.message, reference },
    { status: opts.status ?? 502 },
  );
}
