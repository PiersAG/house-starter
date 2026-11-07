"use client";

// The session-expiry warning (app-business-core issue 525; Matt Murphy step 153:
// "warn 60s before expiry with 'stay signed in'"). EXPIRY_WARNING_SECONDS before
// the session cookie runs out, a dialog offers "Stay signed in", which asks the
// sign-in endpoint for the session (that renews the cookie). If the session runs
// out anyway, unsaved form text is kept (lib/session/drafts.ts) and the user is
// sent to sign in again, returning to this page afterwards.

import { useCallback, useEffect, useRef, useState } from "react";
import { EXPIRY_WARNING_SECONDS } from "@/config/sessions";
import { loginPathFor } from "@/lib/session/return-path";
import { restoreDrafts, saveDrafts } from "@/lib/session/drafts";

export function SessionExpiryWarning({
  expiresAt: initialExpiresAt,
  maxAgeSeconds,
}: {
  expiresAt: number;
  maxAgeSeconds: number;
}) {
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(EXPIRY_WARNING_SECONDS);
  const stayRef = useRef<HTMLButtonElement>(null);

  const signInAgain = useCallback(() => {
    saveDrafts();
    window.location.assign(loginPathFor(window.location.pathname + window.location.search));
  }, []);

  useEffect(() => {
    restoreDrafts();
    const keep = () => saveDrafts();
    window.addEventListener("pagehide", keep);
    return () => window.removeEventListener("pagehide", keep);
  }, []);

  useEffect(() => {
    const tick = window.setInterval(() => {
      const remaining = Math.round((expiresAt - Date.now()) / 1000);
      if (remaining <= 0) {
        window.clearInterval(tick);
        signInAgain();
        return;
      }
      if (remaining <= EXPIRY_WARNING_SECONDS) {
        setLeft(remaining);
        setOpen((was) => {
          if (!was) saveDrafts();
          return true;
        });
      }
    }, 1000);
    return () => window.clearInterval(tick);
  }, [expiresAt, signInAgain]);

  // A modal dialog keeps the keyboard inside it (WCAG 2.1.2, 2.4.3; app-business-core
  // issue 720, Matt Murphy step 117): Tab and Shift+Tab cycle through the dialog's own
  // controls, and focus that lands outside it is brought back. Without this, Tab walked
  // out of the dialog into the page behind it, which a sighted keyboard user cannot see
  // and a screen-reader user is told is not there (aria-modal).
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    stayRef.current?.focus();
    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? items[(at <= 0 ? items.length : at) - 1]
        : items[(at + 1) % items.length];
      e.preventDefault();
      next.focus();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!dialogRef.current?.contains(e.target as Node)) stayRef.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [open]);

  const stay = async () => {
    try {
      const res = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
      const body = (await res.json().catch(() => null)) as { user?: unknown } | null;
      if (res.ok && body?.user) {
        setExpiresAt(Date.now() + maxAgeSeconds * 1000);
        setOpen(false);
        return;
      }
    } catch {
      // fall through: the session could not be renewed
    }
    signInAgain();
  };

  if (!open) return null;
  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expiry-title"
      aria-describedby="session-expiry-text"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-lg">
        <h2 id="session-expiry-title" className="text-lg font-semibold text-text-primary">
          Your session is about to end
        </h2>
        <p id="session-expiry-text" className="mt-2 text-sm text-text-secondary">
          You will be signed out in {left} seconds. Anything you have typed is kept.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            ref={stayRef}
            type="button"
            onClick={stay}
            className="min-h-11 rounded bg-primary px-4 py-2 font-medium text-primary-foreground"
          >
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}
