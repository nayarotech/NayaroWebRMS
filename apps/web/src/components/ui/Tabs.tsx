import type { JSX } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: LucideIcon;
  /** Small count shown beside the label, e.g. open alerts. */
  readonly count?: number;
}

/** Underlined section tabs: switch the view below while staying on the page. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  readonly items: readonly TabItem<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('border-border flex gap-1 overflow-x-auto border-b', className)}
    >
      {items.map(({ value: itemValue, label: itemLabel, icon: Icon, count }) => {
        const selected = itemValue === value;
        return (
          <button
            key={itemValue}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              onChange(itemValue);
            }}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-body font-bold whitespace-nowrap transition-colors',
              selected
                ? 'border-accent text-text'
                : 'text-muted hover:text-text-2 border-transparent',
            )}
          >
            {Icon !== undefined && <Icon aria-hidden size={16} strokeWidth={2.2} />}
            {itemLabel}
            {count !== undefined && count > 0 && (
              <span
                className={cn(
                  'rounded-full px-1.5 text-overline font-extrabold',
                  selected ? 'bg-accent text-white' : 'bg-neutral-tint text-muted',
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Compact pill switcher for filters inside a card or toolbar. */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  readonly items: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
}): JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="bg-neutral-tint inline-flex rounded-control p-0.5">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="radio"
          aria-checked={item.value === value}
          onClick={() => {
            onChange(item.value);
          }}
          className={cn(
            'rounded-[0.5rem] px-3 py-1.5 text-caption font-bold transition-colors',
            item.value === value ? 'bg-surface text-text shadow-card' : 'text-muted hover:text-text-2',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
