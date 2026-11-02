"use client";

import { useActionState, useState, useTransition } from "react";
import {
  deleteMyAccountAction,
  downloadMyDataAction,
  type DeleteState,
} from "./actions";

const INPUT =
  "w-full rounded border border-border bg-background px-3 py-2 text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** Downloads everything the app holds on this account, as one JSON file. */
export function DownloadMyData() {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const download = () =>
    start(async () => {
      setError(null);
      const res = await downloadMyDataAction();
      if (!res?.report) {
        setError(res?.error ?? "Could not prepare your data. Please try again.");
        return;
      }
      const url = URL.createObjectURL(new Blob([res.report], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "my-data.json";
      a.click();
      URL.revokeObjectURL(url);
    });
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={download}
        disabled={pending}
        className="min-h-11 rounded border border-border px-4 py-2 font-medium text-text-primary hover:bg-surface disabled:opacity-60"
      >
        {pending ? "Preparing…" : "Download my data"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Deletes the account: closed at once, data erased 30 days later. */
export function DeleteMyAccount() {
  const [state, action, pending] = useActionState<DeleteState, FormData>(deleteMyAccountAction, null);
  return (
    <form action={action} className="space-y-4" noValidate>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm text-text-secondary">
          Your password
        </label>
        <input id="password" name="password" type="password" required autoComplete="current-password" className={INPUT} />
      </div>
      <div>
        <label htmlFor="confirm" className="mb-1 block text-sm text-text-secondary">
          Type DELETE to confirm
        </label>
        <input id="confirm" name="confirm" type="text" required autoComplete="off" className={INPUT} />
      </div>
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 rounded bg-destructive px-4 py-2 font-medium text-destructive-foreground disabled:opacity-60"
      >
        {pending ? "Deleting…" : "Delete my account and data"}
      </button>
    </form>
  );
}
