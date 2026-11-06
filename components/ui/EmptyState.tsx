interface EmptyStateProps {
  title: string;
  description: string;
  action?: React.ReactNode;
  /**
   * The heading level, so the page's outline never skips a level (WCAG 1.3.1;
   * app-business-core issue 720): 2 directly under a page's h1, 3 under an h2.
   */
  level?: 2 | 3 | 4;
}

export function EmptyState({ title, description, action, level = 3 }: EmptyStateProps) {
  const Heading = `h${level}` as const;
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-6 text-center sm:p-12">
      <Heading className="text-lg font-medium text-text-primary">{title}</Heading>
      <p className="mt-2 text-sm text-text-secondary">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
