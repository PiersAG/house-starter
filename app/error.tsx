"use client";

// The crash screen for any page below the root layout (app-business-core issue
// 502). Next.js shows it when a page throws; "Try again" re-renders the page.
// The server has already recorded the error with its digest
// (instrumentation.ts onRequestError); this screen shows only the digest.

import { useEffect } from "react";
import { SafetyNetMessage } from "@/components/SafetyNetMessage";
import { sendBrowserError } from "@/lib/observability/browser-report";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // A server error arrives here with a digest and was reported by the server
  // already; a browser-only error has none and is sent (issue 761) — only
  // while error tracking is on (lib/observability/browser-report.ts).
  useEffect(() => {
    if (!error.digest) sendBrowserError(error, "boundary");
  }, [error]);
  return <SafetyNetMessage digest={error.digest} onRetry={reset} />;
}
