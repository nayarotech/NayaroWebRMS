import { useState, type JSX } from 'react';
import { cn } from '@/lib/utils';

export interface BarDatum {
  readonly key: string;
  /** Axis label under the bar. */
  readonly label: string;
  readonly value: number;
  /** Tooltip heading and body. */
  readonly title: string;
  readonly detail: string;
  readonly highlight?: boolean;
}

/**
 * Single-series vertical bars: one hue, rounded data-end, recessive grid, and a
 * per-bar tooltip. A single series needs no legend; the card title names it.
 */
export function BarChart({
  data,
  height = 220,
  formatAxis,
  label,
  labelEvery = 1,
}: {
  readonly data: readonly BarDatum[];
  readonly height?: number;
  readonly formatAxis: (value: number) => string;
  readonly label: string;
  /** Show every nth axis label so dense charts stay legible. */
  readonly labelEvery?: number;
}): JSX.Element {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((datum) => datum.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;

  return (
    <figure aria-label={label} className="relative">
      <div className="flex gap-2" style={{ height }}>
        <div className="text-muted-3 flex w-12 shrink-0 flex-col-reverse justify-between pb-6 text-right font-mono text-[11px]">
          {ticks.map((tick) => (
            <span key={tick} className="leading-none">
              {formatAxis(tick)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="absolute inset-x-0 top-0 bottom-6 flex flex-col-reverse justify-between">
            {ticks.map((tick) => (
              <div key={tick} className="border-border border-t border-dashed first:border-solid" />
            ))}
          </div>
          <div className="absolute inset-x-0 top-0 bottom-6 flex items-end gap-[2px]">
            {data.map((datum, index) => (
              <button
                key={datum.key}
                type="button"
                aria-label={`${datum.title}: ${datum.detail}`}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
                className="group flex h-full min-w-0 flex-1 items-end outline-none"
              >
                <span
                  className={cn(
                    'block w-full rounded-t-[4px] transition-opacity',
                    datum.highlight ? 'bg-accent' : 'bg-accent/55',
                    active !== null && active !== index && 'opacity-45',
                  )}
                  style={{ height: `${datum.value === 0 ? 0 : Math.max(2, (datum.value / top) * 100)}%` }}
                />
              </button>
            ))}
          </div>
          <div className="text-muted-3 absolute inset-x-0 bottom-0 flex h-5 gap-[2px] text-[11px]">
            {data.map((datum, index) => (
              <span key={datum.key} className="min-w-0 flex-1 truncate text-center">
                {index % labelEvery === 0 ? datum.label : ''}
              </span>
            ))}
          </div>
          {active !== null && data[active] !== undefined && (
            <div
              role="tooltip"
              className="border-border bg-surface shadow-raised pointer-events-none absolute top-2 z-10 rounded-control border px-3 py-2 text-caption whitespace-nowrap"
              style={{
                left: `${((active + 0.5) / data.length) * 100}%`,
                transform: `translateX(${active > data.length / 2 ? '-100%' : '0'})`,
              }}
            >
              <p className="font-bold">{data[active].title}</p>
              <p className="text-muted">{data[active].detail}</p>
            </div>
          )}
        </div>
      </div>
    </figure>
  );
}

function niceTicks(max: number): number[] {
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough)!;
  return Array.from({ length: 5 }, (_, index) => index * step);
}

/** Horizontal bars for ranked lists (top dishes, payment methods). */
export function RankedBars({
  rows,
  formatValue,
}: {
  readonly rows: readonly { readonly key: string; readonly label: string; readonly value: number; readonly note?: string }[];
  readonly formatValue: (value: number) => string;
}): JSX.Element {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.key} title={`${row.label}: ${formatValue(row.value)}`}>
          <div className="mb-1 flex items-baseline gap-3 text-body">
            <span className="min-w-0 flex-1 truncate font-semibold">{row.label}</span>
            {row.note !== undefined && <span className="text-muted text-caption">{row.note}</span>}
            <span className="font-mono text-caption font-semibold tabular-nums">{formatValue(row.value)}</span>
          </div>
          <div className="bg-neutral-tint h-2 rounded-full">
            <div className="bg-accent h-2 rounded-full" style={{ width: `${(row.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
