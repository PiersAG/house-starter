"use client";

// The pay actions for /reactivate. Reuses the existing billing routes rather
// than reimplementing Stripe:
//   • Subscribe        → POST /api/billing/checkout → hosted Checkout URL
//   • Manage billing   → POST /api/billing/portal   → billing-portal URL
// Both routes are OPEN (auth-only, never paywalled), so an unpaid owner can
// always reach them. A user with no Stripe customer yet subscribes; one with an
// existing customer (e.g. lapsed payment) manages/pays via the portal.

import { useState } from "react";

type Busy = null | "checkout" | "portal";

export function ReactivateActions() {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(which: "checkout" | "portal") {
    setBusy(which);
    setError(null);
    try {
      const res = await fetch(`/api/billing/${which}`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setError(
        data.error ??
          (which === "portal"
            ? "No billing account to manage yet — subscribe to get started."
            : "Couldn’t start checkout. Please try again."),
      );
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-8 flex flex-col gap-3">
      <button
        type="button"
        onClick={() => go("checkout")}
        disabled={busy !== null}
        className="min-h-11 rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
      >
        {busy === "checkout" ? "Starting…" : "Subscribe"}
      </button>
      <button
        type="button"
        onClick={() => go("portal")}
        disabled={busy !== null}
        className="min-h-11 rounded border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
      >
        {busy === "portal" ? "Opening…" : "Manage billing"}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
