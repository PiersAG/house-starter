interface LoadingSpinnerProps {
  label?: string;
}

export function LoadingSpinner({ label = "Loading…" }: LoadingSpinnerProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex items-center justify-center p-8"
    >
      <div
        aria-hidden
        className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-primary"
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}
