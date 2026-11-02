"use client";

// The last-resort crash screen (app-business-core issue 502): shown when the
// root layout itself fails, so it carries its own <html> and <body>. Same
// message as app/error.tsx — plain words, Try again, the digest only.

import { SafetyNetMessage } from "@/components/SafetyNetMessage";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-background text-text-primary">
        <SafetyNetMessage digest={error.digest} onRetry={reset} />
      </body>
    </html>
  );
}
