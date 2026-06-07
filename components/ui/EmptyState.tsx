interface EmptyStateProps {
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-12 text-center">
      <h3 className="text-lg font-medium text-text-primary">{title}</h3>
      <p className="mt-2 text-sm text-text-secondary">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
