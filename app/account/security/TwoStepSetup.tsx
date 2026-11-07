"use client";

// Two-step sign-in set-up (app-business-core issue 377, SEC.15; plan
// wiki/plans/2026-09-15-mfa-build-plan.md slice 6, enrollment screens). Calls the
// existing routes: POST /api/auth/mfa/enroll (a new secret and its QR code, kept
// inactive) and POST /api/auth/mfa/confirm (a code from the app turns it on and
// returns ten single-use recovery codes, shown once). Then the user signs in
// again with a code, which replaces this session's "not set up" mark.

import { useState } from "react";
import { finishTwoStepAction } from "./actions";

type Step =
  | { kind: "idle" }
  | { kind: "scan"; secret: string; qr: string }
  | { kind: "codes"; codes: string[] };

const BUTTON =
  "min-h-11 rounded bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-60";
const INPUT =
  "w-full rounded border border-border bg-background px-3 py-2 text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary";

// The routes refuse a write without this session's CSRF token (lib/csrf.ts); the page
// passes it in. Without it every set-up was refused with "This request could not be
// verified" (found by the awkward-input suite, app-business-core issue 721).
async function post(
  path: string,
  body: unknown,
  csrfToken: string,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

export function TwoStepSetup({
  active,
  required,
  csrfToken,
}: {
  active: boolean;
  required: boolean;
  csrfToken: string;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (active && step.kind !== "codes") {
    return <p className="text-sm text-text-secondary">Two-step sign-in is on for this account.</p>;
  }

  if (step.kind === "codes") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-text-primary">
          Two-step sign-in is on. Keep these recovery codes somewhere safe: each one
          signs you in once if you lose your phone. They are not shown again.
        </p>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm text-text-primary" aria-label="Recovery codes">
          {step.codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <form action={finishTwoStepAction}>
          <button type="submit" className={BUTTON}>
            I have saved them — sign in again
          </button>
        </form>
      </div>
    );
  }

  if (step.kind === "scan") {
    return (
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const r = await post("/api/auth/mfa/confirm", { code }, csrfToken);
          setBusy(false);
          if (r.ok && Array.isArray(r.data.recoveryCodes)) {
            setStep({ kind: "codes", codes: r.data.recoveryCodes as string[] });
          } else {
            setError(typeof r.data.error === "string" ? r.data.error : "That code didn't work. Try the current one.");
          }
        }}
      >
        <p className="text-sm text-text-secondary">
          Scan this with an authenticator app (for example Google Authenticator or
          1Password), or type the key into it, then enter the 6-digit code it shows.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made on the server */}
        <img src={step.qr} alt="QR code for your authenticator app" width={180} height={180} />
        <p className="break-all font-mono text-sm text-text-primary">Key: {step.secret}</p>
        <div>
          <label htmlFor="two-step-code" className="mb-1 block text-sm text-text-secondary">
            Code from the app
          </label>
          <input
            id="two-step-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={INPUT}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy} className={BUTTON}>
          {busy ? "Checking…" : "Turn on two-step sign-in"}
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      {required ? (
        <p role="alert" className="text-sm text-destructive">
          This account holds owner access, so it must use two-step sign-in. Set it
          up to continue.
        </p>
      ) : (
        <p className="text-sm text-text-secondary">
          Ask for a code from your phone as well as your password when you sign in.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={busy}
        className={BUTTON}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const r = await post("/api/auth/mfa/enroll", {}, csrfToken);
          setBusy(false);
          if (r.ok && typeof r.data.secret === "string" && typeof r.data.qrCodeDataUrl === "string") {
            setStep({ kind: "scan", secret: r.data.secret, qr: r.data.qrCodeDataUrl });
          } else {
            setError(typeof r.data.error === "string" ? r.data.error : "Could not start set-up. Please try again.");
          }
        }}
      >
        Set up two-step sign-in
      </button>
    </div>
  );
}
