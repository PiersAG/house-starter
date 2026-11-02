"use client";

// The crash screen for any page below the root layout (app-business-core issue
// 502). Next.js shows it when a page throws; "Try again" re-renders the page.
// The server has already recorded the error with its digest
// (instrumentation.ts onRequestError); this screen shows only the digest.

import { SafetyNetMessage } from "@/components/SafetyNetMessage";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SafetyNetMessage digest={error.digest} onRetry={reset} />;
}
