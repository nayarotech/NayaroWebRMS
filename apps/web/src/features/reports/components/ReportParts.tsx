import type { JSX, ReactNode } from 'react';
import type { PaymentMethod } from '@nayaro/shared';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';

export const METHOD_LABEL: Readonly<Record<PaymentMethod, string>> = {
  CASH: 'Cash',
  QR: 'QR',
  CARD: 'Card',
  CREDIT: 'Credit',
};

/**
 * One colour per payment method, read the same on every card. Credit is amber
 * because it is money still owed, not money in hand.
 */
export const METHOD_SWATCH: Readonly<Record<PaymentMethod, string>> = {
  CASH: 'bg-ok',
  QR: 'bg-accent',
  CARD: 'bg-status-available',
  CREDIT: 'bg-warn',
};

export type MoneyTone = 'ok' | 'warn' | 'danger';

const TONE_TEXT: Record<MoneyTone, string> = {
  ok: 'text-ok-fg',
  warn: 'text-warn-fg',
  danger: 'text-danger-fg',
};

/** A labelled amount on a statement: "Discounts ............ −₨ 120.00". */
export function MoneyRow({
  label,
  hint,
  value,
  tone,
  strong = false,
  muted = false,
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly value: number;
  readonly tone?: MoneyTone;
  readonly strong?: boolean;
  readonly muted?: boolean;
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-baseline gap-3 py-1.5 text-body',
        strong && 'border-border mt-1 border-t pt-2.5 font-bold',
        muted && 'text-muted-3',
      )}
    >
      <span className="min-w-0 flex-1">
        {label}
        {hint !== undefined && <span className="text-muted-2 ml-1.5 text-caption font-medium">{hint}</span>}
      </span>
      <span className={cn('font-mono tabular-nums', tone !== undefined && TONE_TEXT[tone])}>
        {formatPaisa(value)}
      </span>
    </div>
  );
}

export interface SplitSegment {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** Background class for the bar and the legend swatch. */
  readonly swatch: string;
  readonly note?: string;
}

/**
 * Parts of one whole: a stacked bar with a legend underneath carrying the
 * exact figures, so the bar gives the shape and the legend gives the numbers.
 */
export function SplitBar({
  segments,
  label,
  formatValue = formatPaisa,
}: {
  readonly segments: readonly SplitSegment[];
  readonly label: string;
  readonly formatValue?: (value: number) => string;
}): JSX.Element {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const share = (value: number): number => (total === 0 ? 0 : (Math.max(0, value) / total) * 100);

  return (
    <figure aria-label={label}>
      <div className="bg-neutral-tint flex h-3 gap-0.5 overflow-hidden rounded-full">
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => (
            <div
              key={segment.key}
              title={`${segment.label}: ${formatValue(segment.value)}`}
              className={cn('h-full first:rounded-l-full last:rounded-r-full', segment.swatch)}
              style={{ width: `${share(segment.value)}%` }}
            />
          ))}
      </div>
      <ul className="mt-3 space-y-1.5">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2.5 text-body">
            <span aria-hidden className={cn('size-2.5 shrink-0 rounded-[3px]', segment.swatch)} />
            <span className="min-w-0 flex-1 truncate font-semibold">
              {segment.label}
              {segment.note !== undefined && (
                <span className="text-muted-2 ml-1.5 text-caption font-medium">{segment.note}</span>
              )}
            </span>
            <span className="text-muted-2 w-11 text-right font-mono text-caption tabular-nums">
              {Math.round(share(segment.value))}%
            </span>
            <span className="w-28 text-right font-mono tabular-nums">{formatValue(segment.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Small uppercase label that opens a sub-section inside a card. */
export function SubHeading({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <h3 className="text-muted-2 mb-2 text-overline font-bold tracking-wider uppercase">{children}</h3>
  );
}
