import type { JSX } from 'react';
import type { TableStatus } from '@nayaro/shared';
import { cn } from '@/lib/utils';
import { TABLE_STATUS_PRESENTATION } from '../tableStatus';

export interface TableStatusBadgeProps {
  readonly status: TableStatus;
  readonly className?: string;
}

/**
 * Colour is never the only signal. Every badge carries its label in words, so
 * the board is readable by someone who cannot distinguish amber from green -
 * which, in a room of five staff, is a real person often enough to matter.
 */
export function TableStatusBadge({ status, className }: TableStatusBadgeProps): JSX.Element {
  const presentation = TABLE_STATUS_PRESENTATION[status];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11.5px] font-bold',
        presentation.text,
        className,
      )}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', presentation.dot)} />
      {presentation.label}
    </span>
  );
}
