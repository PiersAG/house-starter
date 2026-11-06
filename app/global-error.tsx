"use client";

// The last-resort crash screen (app-business-core issue 502): shown when the
// root layout itself fails, so it carries its own <html> and <body>. Same
// message as app/error.tsx — plain words, Try again, the digest only.

import { useEffect } from "react";
import { SafetyNetMessage } from "@/components/SafetyNetMessage";
import { sendBrowserError } from "@/lib/observability/browser-report";
import "./globals.css";

export default function GlobalError({
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
  return (
    <html lang="en">
      <body className="bg-background text-text-primary">
        <SafetyNetMessage digest={error.digest} onRetry={reset} />
      </body>
    </html>
  );
}
