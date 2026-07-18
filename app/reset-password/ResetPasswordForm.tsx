"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { resetPasswordAction, type ResetPasswordState } from "./actions";

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ResetPasswordState, FormData>(
    resetPasswordAction,
    null,
  );
  const [showPassword, setShowPassword] = useState(false);
  const [inputChanged, setInputChanged] = useState(false);
  const prevState = useRef(state);
  useEffect(() => {
    if (state !== prevState.current) {
      prevState.current = state;
      setInputChanged(false);
    }
  }, [state]);

  const showError = Boolean(state?.error) && !inputChanged;

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />
      <div>
        <label
          htmlFor="password"
          className="mb-1 block text-sm text-text-secondary"
        >
          New password
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            required
            minLength={8}
            autoComplete="new-password"
            aria-describedby={
              showError ? "form-error password-hint" : "password-hint"
            }
            onChange={() => setInputChanged(true)}
            className="w-full rounded border border-border bg-background px-3 py-2 pr-10 text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-text-secondary hover:text-text-primary"
          >
            {showPassword ? (
              <EyeOff size={18} aria-hidden />
            ) : (
              <Eye size={18} aria-hidden />
            )}
          </button>
        </div>
        <p id="password-hint" className="mt-1 text-sm text-text-secondary">
          Use at least 8 characters. Avoid common, easily guessed passwords.
        </p>
      </div>
      {showError && (
        <p id="form-error" role="alert" className="text-sm text-destructive">
          {state!.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 w-full rounded bg-primary px-4 py-2 font-medium text-white disabled:opacity-60"
      >
        {pending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
