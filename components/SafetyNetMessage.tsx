// The message the crash and error screens share (app-business-core issue 502;
// Matt Murphy videos 56, 108, 126, 297). Plain words, a Try again button and a
// support reference — the error's digest, which matches the error row the
// server recorded (instrumentation.ts) — and never the error's message, stack
// or file paths.

import Link from "next/link";

interface Props {
  digest?: string;
  onRetry: () => void;
}

export function SafetyNetMessage({ digest, onRetry }: Props) {
  return (
    <main
      role="alert"
      className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-text-secondary">
        We could not show this page. It has been recorded and we will look at it. Please try
        again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-11 rounded-md bg-primary px-4 py-2 text-primary-foreground"
      >
        Try again
      </button>
      {digest ? (
        <p className="text-sm text-text-secondary">
          If it keeps happening, quote this reference: <code data-testid="error-reference">{digest}</code>
        </p>
      ) : null}
      <Link href="/" className="text-sm underline underline-offset-4">
        Go to the home page
      </Link>
    </main>
  );
}
