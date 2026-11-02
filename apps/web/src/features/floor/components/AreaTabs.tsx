import type { JSX } from 'react';
import type { FloorArea } from '@nayaro/shared';
import { cn } from '@/lib/utils';

/** `null` means "All areas". */
export type AreaSelection = string | null;

export interface AreaTabsProps {
  readonly areas: readonly FloorArea[];
  readonly selected: AreaSelection;
  readonly onSelect: (selection: AreaSelection) => void;
}

/**
 * Area filter.
 *
 * "All areas" is first and is the default: a floor of two areas and twelve
 * tables fits on one screen, and forcing a choice before showing anything would
 * be ceremony. The per-area tabs earn their keep on a larger floor, where a
 * waiter working the rooftop does not want the ground floor in view.
 *
 * Each tab carries its table count, so the filter also answers "how big is
 * this section" without switching to it.
 */
export function AreaTabs({ areas, selected, onSelect }: AreaTabsProps): JSX.Element {
  const total = areas.reduce((count, area) => count + area.tables.length, 0);

  return (
    <div role="tablist" aria-label="Areas" className="flex flex-wrap items-center gap-2">
      <Tab
        label="All areas"
        count={total}
        active={selected === null}
        onClick={() => {
          onSelect(null);
        }}
      />
      {areas.map((area) => (
        <Tab
          key={area.id}
          label={area.name}
          count={area.tables.length}
          inactive={!area.isActive}
          active={selected === area.id}
          onClick={() => {
            onSelect(area.id);
          }}
        />
      ))}
    </div>
  );
}

function Tab({
  label,
  count,
  active,
  inactive = false,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  inactive?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[13px] font-bold transition-colors',
        'focus-visible:ring-accent-hover/50 outline-none focus-visible:ring-2',
        active
          ? 'border-accent bg-accent text-white'
          : 'border-border-2 bg-surface text-text-2 hover:border-accent-hover',
        inactive && 'opacity-60',
      )}
    >
      <span className="truncate">{label}</span>
      <span
        className={cn(
          'rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-semibold',
          active ? 'bg-white/20' : 'bg-neutral-tint text-muted',
        )}
      >
        {count}
      </span>
    </button>
  );
}
