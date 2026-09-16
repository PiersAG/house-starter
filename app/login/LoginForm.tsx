"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { loginAction } from "./actions";

type State = { error: string; mfaRequired?: boolean } | null;

export function LoginForm() {
  const [state, action, pending] = useActionState<State, FormData>(
    loginAction,
    null,
  );
  const [showPassword, setShowPassword] = useState(false);
  // CONTROLLED, so what was typed survives the round trip when the form comes
  // back asking for the second-factor code (SEC.15): React resets uncontrolled
  // fields after a form action, and the code step resubmits email + password.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  // Clear the error as soon as the user starts editing — baseline requirement.
  // useActionState gives us a new state object on each submission; we track
  // whether input has changed since the last result came in.
  const [inputChanged, setInputChanged] = useState(false);
  const prevState = useRef(state);
  useEffect(() => {
    if (state !== prevState.current) {
      prevState.current = state;
      setInputChanged(false);
    }
  }, [state]);

  const showError = state?.error && !inputChanged;

  return (
    <form action={action} className="space-y-4" noValidate>
      <div>
        <label
          htmlFor="email"
          className="mb-1 block text-sm text-text-secondary"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          aria-describedby={showError ? "form-error" : undefined}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setInputChanged(true);
          }}
          className="w-full rounded border border-border bg-background px-3 py-2 text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      </div>
      <div>
        <label
          htmlFor="password"
          className="mb-1 block text-sm text-text-secondary"
        >
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            required
            autoComplete="current-password"
            aria-describedby={showError ? "form-error" : undefined}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setInputChanged(true);
            }}
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
      </div>
      <label className="flex items-center gap-3 text-sm text-text-secondary">
        <input
          name="rememberMe"
          type="checkbox"
          checked={rememberMe}
          onChange={(e) => setRememberMe(e.target.checked)}
          // WCAG 2.5.8 target-size floor is 24×24 CSS px. h-6 w-6 = 24px hits
          // it exactly; do not shrink below h-6/w-6 or the responsive gate and
          // axe target-size will flag it on /login.
          className="h-6 w-6 rounded border-border accent-primary"
        />
        Remember me for 30 days
      </label>
      {state?.mfaRequired && (
        <div>
          <label htmlFor="code" className="mb-1 block text-sm text-text-secondary">
            Authentication code
          </label>
          <input
            id="code"
            name="code"
            type="text"
            required
            autoFocus
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby={showError ? "form-error code-help" : "code-help"}
            onChange={() => setInputChanged(true)}
            className="w-full rounded border border-border bg-background px-3 py-2 text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <p id="code-help" className="mt-1 text-sm text-text-secondary">
            From your authenticator app, or one of your recovery codes.
          </p>
        </div>
      )}
      {showError && (
        <p id="form-error" role="alert" className="text-sm text-destructive">
          {state!.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 w-full rounded bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
