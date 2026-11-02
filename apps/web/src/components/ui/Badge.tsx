import type { JSX, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-tint text-muted',
  accent: 'bg-accent-soft text-accent-hover',
  success: 'bg-ok/12 text-ok-fg',
  warning: 'bg-warn/14 text-warn-fg',
  danger: 'bg-danger/12 text-danger-fg',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  className,
  children,
}: {
  readonly tone?: BadgeTone;
  readonly dot?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-bold whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
