import type { JSX, ReactNode } from 'react';
import { AlertTriangle, Inbox, Lock, type LucideIcon, WifiOff } from 'lucide-react';
import { ApiRequestError } from '@/services/apiClient';
import { cn } from '@/lib/utils';
import { Button } from './Button';

export function LoadingState({
  label = 'Loading…',
  className,
}: {
  readonly label?: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <div
      role="status"
      className={cn('text-muted flex items-center justify-center gap-3 py-16 text-body', className)}
    >
      <span
        aria-hidden
        className="border-accent size-5 animate-spin rounded-full border-2 border-t-transparent"
      />
      {label}
    </div>
  );
}

/** Placeholder rows for tables and lists while their first page loads. */
export function SkeletonRows({ rows = 5 }: { readonly rows?: number }): JSX.Element {
  return (
    <div role="status" aria-label="Loading" className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="bg-neutral-tint h-10 animate-pulse rounded-control" />
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <span className="bg-accent-soft text-accent-hover grid size-12 place-items-center rounded-card">
        <Icon aria-hidden size={22} strokeWidth={2} />
      </span>
      <h3 className="mt-4 text-heading font-extrabold tracking-tight">{title}</h3>
      {description !== undefined && (
        <p className="text-muted mt-1.5 max-w-md text-body">{description}</p>
      )}
      {action !== undefined && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * The error state for a screen or card that could not load. A 403 is not a
 * failure - it means this role is not meant to be here - so it gets its own
 * calm wording instead of an alarm.
 */
export function ErrorState({
  error,
  forbiddenMessage = 'Ask an owner or manager if you need access.',
  onRetry,
  className,
}: {
  readonly error: unknown;
  readonly forbiddenMessage?: string;
  readonly onRetry?: () => void;
  readonly className?: string;
}): JSX.Element {
  const forbidden = error instanceof ApiRequestError && error.status === 403;
  const offline = error instanceof ApiRequestError && error.kind === 'network';
  const message =
    error instanceof ApiRequestError
      ? error.message
      : 'Something went wrong. Try again in a moment.';
  return (
    <EmptyState
      className={className}
      icon={forbidden ? Lock : offline ? WifiOff : AlertTriangle}
      title={forbidden ? 'Not available for your role' : offline ? 'You are offline' : 'Could not load this'}
      description={forbidden ? forbiddenMessage : message}
      action={
        onRetry !== undefined && !forbidden ? (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}

export function InlineAlert({
  tone = 'danger',
  children,
  onDismiss,
  className,
}: {
  readonly tone?: 'danger' | 'warning' | 'info' | 'success';
  readonly children: ReactNode;
  readonly onDismiss?: () => void;
  readonly className?: string;
}): JSX.Element {
  const tones = {
    danger: 'border-danger/30 bg-danger/8 text-danger-fg',
    warning: 'border-warn/30 bg-warn/10 text-warn-fg',
    info: 'border-accent/25 bg-accent-soft text-accent-hover',
    success: 'border-ok/30 bg-ok/10 text-ok-fg',
  } as const;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'animate-rise flex items-start gap-3 rounded-control border px-3.5 py-2.5 text-body font-semibold',
        tones[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss !== undefined && (
        <button type="button" onClick={onDismiss} className="shrink-0 underline underline-offset-2">
          Dismiss
        </button>
      )}
    </div>
  );
}
