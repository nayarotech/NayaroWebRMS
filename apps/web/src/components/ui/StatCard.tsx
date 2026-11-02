import type { JSX, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StatCardProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly icon?: LucideIcon;
  /** Secondary line: a comparison, a count, or context. */
  readonly detail?: ReactNode;
  readonly tone?: 'default' | 'accent' | 'warning' | 'danger';
  readonly onClick?: () => void;
}

const ICON_TONES = {
  default: 'bg-neutral-tint text-muted',
  accent: 'bg-accent-soft text-accent-hover',
  warning: 'bg-warn/14 text-warn-fg',
  danger: 'bg-danger/12 text-danger-fg',
} as const;

export function StatCard({
  label,
  value,
  icon: Icon,
  detail,
  tone = 'default',
  onClick,
}: StatCardProps): JSX.Element {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted text-caption font-semibold">{label}</p>
        {Icon !== undefined && (
          <span className={cn('grid size-9 shrink-0 place-items-center rounded-control', ICON_TONES[tone])}>
            <Icon aria-hidden size={18} strokeWidth={2.2} />
          </span>
        )}
      </div>
      <p className="mt-1 font-mono text-[1.5rem] leading-8 font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {detail !== undefined && <div className="text-muted mt-1 text-caption">{detail}</div>}
    </>
  );
  const shell = 'border-border bg-surface shadow-card rounded-card border p-4 text-left';
  return onClick === undefined ? (
    <div className={shell}>{body}</div>
  ) : (
    <button
      type="button"
      onClick={onClick}
      className={cn(shell, 'hover:border-border-4 transition-colors')}
    >
      {body}
    </button>
  );
}
