"use client";

import { useActionState } from "react";
import { revokeFromEmailAction, type RevokeState } from "./actions";

export function RevokeForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<RevokeState, FormData>(revokeFromEmailAction, null);
  if (state?.done) {
    return (
      <p role="status" className="text-sm text-text-primary">
        That device is signed out. Now{" "}
        <a href="/login?callbackUrl=%2Faccount%2Fsecurity" className="underline">
          sign in and change your password
        </a>
        .
      </p>
    );
  }
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="t" value={token} />
      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 rounded bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-60"
      >
        {pending ? "Signing out…" : "Sign that device out"}
      </button>
    </form>
  );
}
