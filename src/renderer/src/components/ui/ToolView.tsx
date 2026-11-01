import type { ReactNode } from 'react';

/** The frame every tool view (SFTP, forwarding, snippets, …) shares, matching the host panel. */
export function ToolView({
  title,
  description,
  actions,
  children,
  testId
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <main
      data-testid={testId}
      aria-label={title}
      className="flex h-full min-h-0 min-w-0 flex-col rounded-panel border border-border bg-host-panel"
    >
      <header className="flex min-h-[50px] flex-none items-center gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-text">{title}</h1>
          {description && <p className="truncate text-[11px] text-secondary">{description}</p>}
        </div>
        {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </main>
  );
}

/** A thin progress bar; `value` from 0 to 1, or null while the total is unknown. */
export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
      className="h-1 w-full overflow-hidden rounded-full bg-raised"
    >
      <div
        className={value === null ? 'h-full w-1/3 rounded-full bg-subtle' : 'h-full rounded-full bg-cyan transition-[width] duration-120'}
        style={value === null ? undefined : { width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}
