"use client";

import { useActionState } from "react";
import { changePasswordAction, type ChangePasswordState } from "./actions";

const INPUT =
  "w-full rounded border border-border bg-background px-3 py-2 text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary";

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<ChangePasswordState, FormData>(
    changePasswordAction,
    null,
  );
  return (
    <form action={action} className="space-y-4" noValidate>
      <div>
        <label htmlFor="currentPassword" className="mb-1 block text-sm text-text-secondary">
          Current password
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          className={INPUT}
        />
      </div>
      <div>
        <label htmlFor="newPassword" className="mb-1 block text-sm text-text-secondary">
          New password
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          aria-describedby="new-password-hint"
          className={INPUT}
        />
        <p id="new-password-hint" className="mt-1 text-sm text-text-secondary">
          Use at least 8 characters. You will be signed out on every device and
          asked to sign in again.
        </p>
      </div>
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 rounded bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-60"
      >
        {pending ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
